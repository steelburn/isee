'use strict';
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const sharp = require('sharp');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const db = require('./db');
const vision = require('./detect/vision');
const understand = require('./detect/understand');
const { Pipeline } = require('./pipeline');
const { createMcpServer } = require('./mcp');
const { listDevices, kindOf } = require('./capture/camera');
const discovery = require('./discovery');
const probe = require('./probe');

const PORT = Number(process.env.PORT || 7373);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, '..', 'public');

/* index.html with cache-busted asset URLs derived from file mtimes */
let htmlCache = { v: 0, body: '' };
function indexHtml() {
  const names = ['index.html', 'app.css', 'app.js'];
  const v = Math.round(Math.max(...names.map((n) => {
    try { return fs.statSync(path.join(PUBLIC, n)).mtimeMs; } catch { return 0; }
  })));
  if (htmlCache.v !== v) {
    const body = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
      .replace('/app.css', `/app.css?v=${v}`)
      .replace('/app.js', `/app.js?v=${v}`);
    htmlCache = { v, body };
  }
  return htmlCache.body;
}

const pipeline = new Pipeline();
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));

/* ------------------------------------------------------------------ */
/* live channel                                                        */
/* ------------------------------------------------------------------ */

const clients = new Set();

function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

pipeline.on('detection', (d) => broadcast('detection', d));
pipeline.on('camera', (c) => broadcast('camera', c));
pipeline.on('event', (e) => broadcast('event', e));
pipeline.on('detect:error', (e) => broadcast('warn', e));

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify(statePayload())}\n\n`);
  clients.add(res);
  const beat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closed */ }
  }, 20000);
  const cleanup = () => {
    clearInterval(beat);
    clients.delete(res);
  };
  // res 'close' is the reliable signal for a client that hung up on a long-lived response
  res.on('close', cleanup);
  res.on('error', cleanup);
  req.on('aborted', cleanup);
});

/* ------------------------------------------------------------------ */
/* MJPEG                                                               */
/* ------------------------------------------------------------------ */

app.get('/stream/:id.mjpg', (req, res) => {
  const src = pipeline.source(req.params.id);
  if (!src) return res.status(404).end('no such camera');

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
  });

  const onFrame = (buf) => {
    if (res.writableEnded || res.destroyed) { cleanup(); return; }
    try {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
      res.write(buf);
      res.write('\r\n');
    } catch {
      cleanup();
    }
  };
  const cleanup = () => {
    src.off('frame', onFrame);
    if (!res.writableEnded) { try { res.end(); } catch { /* already closed */ } }
  };
  src.on('frame', onFrame);
  if (src.latest) onFrame(src.latest);
  res.on('close', cleanup);
  res.on('error', cleanup);
  req.on('aborted', cleanup);
});

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

function statePayload() {
  const settings = db.getSettings();
  const people = db.listPersons();
  return {
    models: vision.modelStatus(),
    cameras: pipeline.cameras().map((c) => {
      const { analysis, ...rest } = c;
      return { ...rest, analysis: analysis ? { objects: analysis.objects, faces: analysis.faces, ts: analysis.ts } : null };
    }),
    people,
    settings,
    gallerySize: db.faceGallery().length,
    stats: db.stats(),
    eventsToday: db.eventStats(Date.now() - 86400000),
  };
}

app.get('/api/state', (req, res) => res.json(statePayload()));

/* cameras */
app.get('/api/cameras', (req, res) => res.json(pipeline.cameras()));

app.post('/api/cameras', async (req, res) => {
  try {
    const body = req.body || {};
    const { name, size = null, detectFps = 2 } = body;

    // The console sends the parts (host, credentials, channel) rather than a
    // finished URL, so percent-encoding a password into a URL is never an
    // operator's problem, and the stored source comes from one builder.
    let { source, kind } = body;
    if (body.preset) {
      source = probe.buildSource(body);
      if (!source) return res.status(400).json({ error: 'Enter an address.' });
      kind = kindOf(source);
    }
    if (!name || !source) return res.status(400).json({ error: 'name and source are required' });
    if (!kind) kind = kindOf(source);

    const cam = db.addCamera({ name, kind, source, size, detectFps: Number(detectFps) || 2 });
    pipeline.ensure(db.getCamera(cam.id));
    res.status(201).json({ ...cam, masked: probe.mask(source) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ask before committing: one frame from the address the form describes */
app.post('/api/cameras/probe', async (req, res) => {
  try {
    const spec = req.body || {};
    const hasAddress = spec.source || spec.host;
    if (!hasAddress) return res.status(400).json({ error: 'Enter an address first.' });
    res.json(await probe.probe(spec));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* cameras on the wire, so nobody has to type an IP they cannot see */
app.get('/api/discover', async (req, res) => {
  try {
    const result = await discovery.discover({ force: req.query.refresh === '1' });
    const known = new Set(
      pipeline.cameras()
        .map((c) => String(c.source || '').replace(/^[a-z]+:\/\/(?:[^@/]*@)?/i, '').split(/[/:?]/)[0])
        .filter(Boolean),
    );
    res.json({ ...result, hosts: result.hosts.map((h) => ({ ...h, added: known.has(h.host) })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/cameras/:id', (req, res) => {
  const cam = db.getCamera(req.params.id);
  if (!cam) return res.status(404).json({ error: 'camera not found' });
  const patch = {};
  for (const k of ['name', 'kind', 'source', 'size', 'enabled', 'detectFps']) {
    if (k in (req.body || {})) patch[k] = req.body[k];
  }
  if ('detectFps' in patch) patch.detectFps = Number(patch.detectFps) || 2;
  const updated = db.updateCamera(cam.id, patch);
  pipeline.ensure(updated);
  res.json(updated);
});

app.delete('/api/cameras/:id', (req, res) => {
  const cam = db.getCamera(req.params.id);
  if (!cam) return res.status(404).json({ error: 'camera not found' });
  pipeline.remove(cam.id);
  db.removeCamera(cam.id);
  res.json({ removed: cam.id });
});

app.get('/api/cameras/:id/frame.jpg', (req, res) => {
  const f = pipeline.frame(req.params.id);
  if (!f) return res.status(404).json({ error: 'no frame yet' });
  res.set('Cache-Control', 'no-store');
  res.type('image/jpeg').send(f.buffer);
});

app.get('/api/cameras/:id/analyse', async (req, res) => {
  try {
    const data = await pipeline.analyseNow(req.params.id, {
      objectConfidence: req.query.minConfidence ? Number(req.query.minConfidence) : undefined,
      matchThreshold: req.query.threshold ? Number(req.query.threshold) : undefined,
    });
    res.json(data);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/devices', async (req, res) => {
  try { res.json(await listDevices()); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cameras/:id/inspect', async (req, res) => {
  try {
    const { box } = req.body || {};
    if (!Array.isArray(box) || box.length !== 4 || box.some((n) => typeof n !== 'number')) {
      return res.status(400).json({ error: 'box must be [x, y, w, h] in normalised coordinates' });
    }
    res.json(await pipeline.inspectRegion(req.params.id, box));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* people */
app.get('/api/people', (req, res) => {
  res.json(db.listPersons());
});

async function facesFromRequest(body) {
  if (body.image) {
    return { scan: await pipeline.facesInImage(Buffer.from(String(body.image).replace(/^data:image\/\w+;base64,/, ''), 'base64')) };
  }
  const camId = body.cameraId;
  if (!camId) throw new Error('provide a cameraId or an image');
  const f = pipeline.frame(camId);
  if (!f) throw new Error('that camera has no frame yet');
  return { scan: await pipeline.facesInImage(f.buffer) };
}

app.post('/api/people', async (req, res) => {
  try {
    const { name, note = '' } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    const { scan } = await facesFromRequest(req.body);
    if (!scan.faces.length) return res.status(422).json({ error: 'No face found. Look straight at the camera in even light, then try again.' });
    const best = pipeline.pickFaceNear(scan, req.body.box);
    if (!best) return res.status(422).json({ error: 'No face found in the marked area.' });
    const person = db.createPerson({ name: name.trim(), note });
    const thumbName = await pipeline.saveFaceThumb(scan.raw, best.box, `face-${person.id}`);
    db.addFace({ personId: person.id, embedding: best.vector, thumb: thumbName, quality: best.quality });
    res.status(201).json({ ...person, samples: 1, quality: best.quality });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/people/:id/samples', async (req, res) => {
  try {
    const person = db.getPerson(req.params.id);
    if (!person) return res.status(404).json({ error: 'person not found' });
    const { scan } = await facesFromRequest(req.body);
    if (!scan.faces.length) return res.status(422).json({ error: 'No face found in this frame.' });
    const best = pipeline.pickFaceNear(scan, req.body.box);
    if (!best) return res.status(422).json({ error: 'No face found in the marked area.' });
    const thumbName = await pipeline.saveFaceThumb(scan.raw, best.box, `face-${person.id}`);
    db.addFace({ personId: person.id, embedding: best.vector, thumb: thumbName, quality: best.quality });
    res.json({ ...person, samples: db.listFaces(person.id).length });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/people/:id', (req, res) => {
  const person = db.getPerson(req.params.id);
  if (!person) return res.status(404).json({ error: 'person not found' });
  for (const f of db.listFaces(person.id)) {
    if (f.thumb) { try { require('node:fs').unlinkSync(db.shotPath(f.thumb)); } catch { /* gone */ } }
  }
  db.removePerson(person.id);
  res.json({ removed: person.id });
});

app.delete('/api/faces/:id', (req, res) => {
  const row = db.removeFace(req.params.id);
  if (!row) return res.status(404).json({ error: 'sample not found' });
  if (row.thumb) { try { require('node:fs').unlinkSync(db.shotPath(row.thumb)); } catch { /* gone */ } }
  res.json({ removed: req.params.id });
});

/* events */
app.get('/api/events', (req, res) => {
  const { cameraId, kind, label, personId, since, until, limit = 40, offset = 0 } = req.query;
  const rows = db.queryEvents({
    cameraId: cameraId || null,
    kind: kind || null,
    label: label || null,
    personId: personId || null,
    since: since ? Number(since) : null,
    until: until ? Number(until) : null,
    limit: Number(limit) || 40,
    offset: Number(offset) || 0,
  });
  res.json(rows.map((e) => ({ ...e, snapshot: db.shotUrl(e.snapshot) })));
});

app.get('/api/events/labels', (req, res) => {
  const rows = db.db.prepare(
    'SELECT label, kind, COUNT(*) AS n FROM events GROUP BY label, kind ORDER BY n DESC LIMIT 24',
  ).all();
  res.json(rows);
});

/* settings */
app.get('/api/settings', (req, res) => res.json(db.getSettings()));
app.patch('/api/settings', (req, res) => {
  const body = req.body || {};
  const patch = {};
  for (const k of ['objectConfidence', 'faceConfidence', 'matchThreshold', 'eventCooldownMs', 'retainDays']) {
    if (k in body) patch[k] = Number(body[k]);
  }
  if ('refineObjects' in body) patch.refineObjects = !!body.refineObjects;
  if ('vocabulary' in body) {
    const list = Array.isArray(body.vocabulary)
      ? body.vocabulary
      : String(body.vocabulary || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    patch.vocabulary = list;
  }
  res.json(db.setSettings(patch));
});

/* ------------------------------------------------------------------ */
/* MCP — streamable HTTP, stateless: one server per request            */
/* ------------------------------------------------------------------ */

app.post('/mcp', async (req, res) => {
  const server = createMcpServer(pipeline);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null });
  }
});

const methodNotAllowed = (req, res) => res.status(405).json({
  jsonrpc: '2.0',
  error: { code: -32000, message: 'This is a stateless MCP endpoint. Use POST /mcp.' },
  id: null,
});
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

/* ------------------------------------------------------------------ */
/* static                                                              */
/* ------------------------------------------------------------------ */

app.use('/shots', express.static(db.SHOTS, { maxAge: '7d', immutable: true }));
app.get('/', (req, res) => res.set('Cache-Control', 'no-store').type('html').send(indexHtml()));
app.use(express.static(PUBLIC, {
  extensions: ['html'],
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

app.get('/health', (req, res) => res.json({
  ok: true,
  models: vision.modelStatus().status,
  cameras: pipeline.sources.size,
  sseClients: clients.size,
  streamClients: [...pipeline.sources.values()].reduce((n, s) => n + s.listenerCount('frame'), 0),
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.set('Cache-Control', 'no-store').type('html').send(indexHtml());
});

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function seed() {
  if (db.listCameras().length) return;
  try {
    const devices = await listDevices();
    const first = devices[0];
    if (first) {
      db.addCamera({
        name: first.name.includes('Webcam') ? 'Local webcam' : first.name,
        kind: 'webcam',
        source: first.id,
        size: '1920x1080',
        detectFps: 2,
      });
      console.log(`[isee] seeded camera from local device: ${first.name}`);
    }
  } catch (err) {
    console.warn('[isee] could not enumerate devices:', err.message);
  }
}

async function boot() {
  await seed();
  pipeline.start();

  const server = app.listen(PORT, HOST, () => {
    console.log(`\n  isee  ·  http://${HOST}:${PORT}`);
    console.log(`  mcp   ·  http://${HOST}:${PORT}/mcp  (streamable HTTP)\n`);
  });

  vision.loadModels()
    .then(() => console.log(`[isee] models ready in ${vision.modelStatus().ms} ms`))
    .catch((err) => console.error('[isee] model load failed:', err.message));

  // CLIP and OCR are only needed on demand, but warming them now keeps the
  // first marked region responsive.
  setTimeout(() => {
    understand.warm().then((r) => {
      if (r.clip && r.clip.status === 'ready') console.log(`[isee] open vocabulary ready in ${r.clip.ms} ms`);
    }).catch(() => { /* optional */ });
  }, 1500).unref?.();

  db.pruneEvents(db.getSettings().retainDays || 30);
  setInterval(() => db.pruneEvents(db.getSettings().retainDays || 30), 6 * 3600 * 1000).unref();

  const shutdown = () => {
    console.log('\n[isee] shutting down');
    pipeline.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

boot().catch((err) => {
  console.error('[isee] boot failed:', err);
  process.exit(1);
});

module.exports = { app, pipeline };
