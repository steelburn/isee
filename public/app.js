/* isee client — no framework, one state object, explicit renders. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const pad = (n) => String(n).padStart(2, '0');
const hhmmss = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
};
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const dateTime = (ts) => {
  const d = new Date(ts);
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(d)}`;
};

/* ------------------------------------------------------------------ */
/* icons                                                               */
/* ------------------------------------------------------------------ */

const ICONS = {
  plus: '<path d="M10 4v12M4 10h12"/>',
  trash: '<path d="M3.5 5.5h13M8 5.5V3.8h4v1.7M5.5 5.5l.8 10.2h7.4l.8-10.2"/>',
  upload: '<path d="M10 13V3.8M6.4 7.2L10 3.6l3.6 3.6M3.5 13v2.4h13V13"/>',
  camera: '<rect x="2" y="4" width="16" height="12" rx="2"/><circle cx="10" cy="10" r="3"/>',
  refresh: '<path d="M16 10a6 6 0 1 1-1.8-4.3M16 3.2V6h-2.8"/>',
  copy: '<rect x="7" y="7" width="9" height="9" rx="1.6"/><path d="M13 7V4.6H4.6V13H7"/>',
  check: '<path d="M4 10.5l4 4 8-8.5"/>',
  user: '<circle cx="10" cy="7" r="3.2"/><path d="M4 17c0-3.3 2.7-5.4 6-5.4s6 2.1 6 5.4"/>',
  play: '<path d="M6.5 4.4l9 5.6-9 5.6z"/>',
  stop: '<rect x="5" y="5" width="10" height="10" rx="1.2"/>',
};
const icon = (name) => `<svg class="ico" viewBox="0 0 20 20" aria-hidden="true">${ICONS[name] || ''}</svg>`;

/* ------------------------------------------------------------------ */
/* api + ui primitives                                                 */
/* ------------------------------------------------------------------ */

async function api(path, options = {}) {
  const opts = { ...options, headers: { ...(options.headers || {}) } };
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  const type = res.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((body && body.error) || res.statusText || 'request failed');
  return body;
}

function toast(message, tone = 'info') {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.tone = tone;
  el.innerHTML = `<p>${esc(message)}</p>`;
  host.append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, tone === 'error' ? 7000 : 4200);
}

/* modal ------------------------------------------------------------- */

const modalRoot = $('#modal-root');
let lastFocused = null;

function openModal({ title, body, footer = '', size = '', onMount }) {
  lastFocused = document.activeElement;
  $('#modal').className = size ? `modal is-${size}` : 'modal';
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-foot').innerHTML = footer;
  modalRoot.hidden = false;
  document.body.style.overflow = 'hidden';
  const focusTarget = modalRoot.querySelector('input, select, button');
  if (focusTarget) focusTarget.focus({ preventScroll: true });
  if (onMount) onMount(modalRoot);
}

function closeModal() {
  modalRoot.hidden = true;
  document.body.style.overflow = '';
  $('#modal-body').innerHTML = '';
  $('#modal-foot').innerHTML = '';
  if (lastFocused && lastFocused.focus) lastFocused.focus({ preventScroll: true });
}

modalRoot.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalRoot.hidden) closeModal();
});

function confirmDialog({ title, message, confirmLabel = 'Remove', onConfirm }) {
  openModal({
    title,
    body: `<p class="muted">${esc(message)}</p>`,
    footer: `<button class="btn" type="button" data-close>Cancel</button>
             <button class="btn btn-danger" type="button" id="confirm-go">${esc(confirmLabel)}</button>`,
    onMount: () => {
      $('#confirm-go').onclick = async () => {
        const btn = $('#confirm-go');
        btn.disabled = true;
        try { await onConfirm(); closeModal(); } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
      };
    },
  });
}

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

const state = {
  models: { status: 'loading' },
  cameras: [],
  people: [],
  settings: {},
  gallerySize: 0,
  stats: { people: 0, samples: 0, facesToday: 0, unknownToday: 0, objectsToday: 0, eventsToday: 0 },
  selectedId: null,
  detections: new Map(),
  events: [],
  labels: [],
  devices: null,
  route: 'live',
  liveSince: new Map(),
  loading: { events: false, people: false },
};

function cameraById(id) { return state.cameras.find((c) => c.id === id) || null; }
function selectedCamera() { return cameraById(state.selectedId) || state.cameras[0] || null; }

function pickSelected() {
  if (state.selectedId && cameraById(state.selectedId)) return;
  const first = state.cameras.find((c) => c.enabled) || state.cameras[0];
  state.selectedId = first ? first.id : null;
}

/* ------------------------------------------------------------------ */
/* live channel                                                        */
/* ------------------------------------------------------------------ */

let es = null;
let esRetry = 0;

function connectLive() {
  if (es) es.close();
  es = new EventSource('/api/stream');

  es.addEventListener('hello', (e) => {
    const data = JSON.parse(e.data);
    hydrate(data);
    esRetry = 0;
  });

  es.addEventListener('detection', (e) => {
    const d = JSON.parse(e.data);
    state.detections.set(d.cameraId, d);
    if (state.route === 'live') {
      updateLiveDynamic();
      paintStage();
    }
  });

  es.addEventListener('camera', (e) => {
    const snap = JSON.parse(e.data);
    const cam = cameraById(snap.id);
    if (!cam) return;
    cam.state = { ...cam.state, ...snap };
    if (snap.status === 'live' && !state.liveSince.has(snap.id)) {
      state.liveSince.set(snap.id, Date.now());
    }
    if (snap.status !== 'live') state.liveSince.delete(snap.id);
    renderChrome();
    renderRoute({ lightweight: true });
  });

  es.addEventListener('event', (e) => {
    const ev = JSON.parse(e.data);
    state.events.unshift(ev);
    state.events = state.events.slice(0, 60);
    if (state.route === 'live') renderRecent();
    if (state.route === 'events' && matchesFilters(ev)) renderEventsList();
  });

  es.addEventListener('warn', (e) => {
    try { console.warn('detect:', JSON.parse(e.data)); } catch { /* ignore */ }
  });

  es.onerror = () => {
    const status = $('#rail-status-text');
    if (status) status.textContent = 'reconnecting';
    esRetry = Math.min(esRetry + 1, 5);
    es.close();
    setTimeout(connectLive, Math.min(8000, 400 * 2 ** esRetry));
  };
}

function hydrate(data) {
  state.models = data.models;
  state.cameras = data.cameras;
  state.people = data.people;
  state.settings = data.settings;
  state.gallerySize = data.gallerySize;
  state.stats = data.stats || state.stats;
  pickSelected();
  for (const cam of state.cameras) {
    if (cam.state.status === 'live' && !state.liveSince.has(cam.id)) state.liveSince.set(cam.id, Date.now());
  }
  renderChrome();
  renderRoute({ full: true });
}

async function refreshState({ quiet = true } = {}) {
  try {
    const data = await api('/api/state');
    state.models = data.models;
    state.cameras = data.cameras;
    state.people = data.people;
    state.settings = data.settings;
    state.gallerySize = data.gallerySize;
    state.stats = data.stats || state.stats;
    pickSelected();
    renderChrome();
    renderRoute({ full: true });
  } catch (err) {
    if (!quiet) toast(err.message, 'error');
  }
}

/* keep frame counters and status fresh without rebuilding the live view */
async function pollCameras() {
  try {
    const cams = await api('/api/cameras');
    let changed = false;
    for (const fresh of cams) {
      const cam = cameraById(fresh.id);
      if (!cam) { changed = true; continue; }
      if (cam.state && cam.state.status !== fresh.state.status) changed = true;
      cam.state = fresh.state;
      if (fresh.analysis) state.detections.set(fresh.id, { ...fresh.analysis, cameraId: fresh.id });
      if (fresh.state.status === 'live' && !state.liveSince.has(fresh.id)) state.liveSince.set(fresh.id, Date.now());
      if (fresh.state.status !== 'live') state.liveSince.delete(fresh.id);
    }
    if (cams.length !== state.cameras.length) changed = true;
    if (changed) {
      renderChrome();
      if (state.route === 'live') { liveSig = ''; renderLive({ full: true }); }
    } else if (state.route === 'live') {
      updateLiveDynamic();
    }
  } catch { /* transient */ }
}

/* ------------------------------------------------------------------ */
/* chrome                                                              */
/* ------------------------------------------------------------------ */

const ROUTE_META = {
  live: { title: 'Live', hash: '#/live' },
  people: { title: 'People', hash: '#/people' },
  events: { title: 'Events', hash: '#/events' },
  settings: { title: 'Settings', hash: '#/settings' },
};

function renderChrome() {
  $$('.nav-item').forEach((a) => {
    if (a.dataset.route === state.route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const meta = ROUTE_META[state.route];
  $('#view-title').textContent = meta.title;

  const modelsReady = state.models.status === 'ready';
  const enabled = state.cameras.filter((c) => c.enabled);
  const live = state.cameras.filter((c) => c.state && c.state.status === 'live');
  const subs = {
    live: `${live.length}/${enabled.length} cameras live · ${modelsReady ? 'detection ready' : 'loading models'}`,
    people: `${state.people.length} people · ${state.gallerySize} face samples`,
    events: state.stats.facesToday || state.stats.objectsToday
      ? `${state.stats.facesToday} face · ${state.stats.objectsToday} object today`
      : 'no activity today',
    settings: `localhost · http://127.0.0.1:${location.port || '7373'}`,
  };
  $('#view-sub').textContent = subs[state.route];

  const text = $('#rail-status-text');
  const dot = $('#rail-status .dot');
  if (state.models.status === 'error') {
    text.textContent = 'models unavailable';
    dot.dataset.tone = 'error';
  } else if (!modelsReady) {
    text.textContent = 'loading models';
    dot.dataset.tone = 'warn';
  } else if (!enabled.length) {
    text.textContent = 'no cameras';
    dot.dataset.tone = 'idle';
  } else {
    text.textContent = `${live.length}/${enabled.length} live`;
    dot.dataset.tone = live.length === enabled.length ? 'live' : 'warn';
  }
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

function routeFromHash() {
  const h = location.hash.replace(/^#\/?/, '').split('?')[0];
  return ['live', 'people', 'events', 'settings'].includes(h) ? h : 'live';
}

function navigate() {
  state.route = routeFromHash();
  renderChrome();
  renderRoute({ full: true });
}

window.addEventListener('hashchange', navigate);

/* ------------------------------------------------------------------ */
/* render dispatcher                                                   */
/* ------------------------------------------------------------------ */

const root = () => $('#view-root');
let liveSig = '';
let liveEls = null;

function teardownLive() {
  stopFeed();
  stopStageLoop();
  if (stageObserver) { stageObserver.disconnect(); stageObserver = null; }
  liveEls = null;
  liveSig = '';
}

function renderRoute({ full = false, lightweight = false } = {}) {
  if (state.route !== 'live') teardownLive();
  switch (state.route) {
    case 'live': renderLive({ full, lightweight }); break;
    case 'people': if (full) renderPeople(); break;
    case 'events': if (full) renderEvents(); break;
    case 'settings': if (full) renderSettings(); break;
    default: break;
  }
}

/* ================================================================== */
/* LIVE                                                                */
/* ================================================================== */

function renderLive({ full }) {
  const sig = [
    state.cameras.map((c) => c.id).join(','),
    state.selectedId || '',
    state.models.status,
  ].join('|');

  if (full || sig !== liveSig || !liveEls) {
    buildLive();
    liveSig = sig;
  }
  updateLiveDynamic();
  paintStage();
}

function buildLive() {
  teardownLive();
  const cam = selectedCamera();

  if (!state.cameras.length) {
    root().innerHTML = `
      <div class="panel">
        <div class="empty">
          <strong>No cameras yet</strong>
          <p>Connect a USB webcam — it will appear here — or add a network stream from an IP camera.</p>
          <button class="btn btn-primary" type="button" data-action="add-camera">${icon('plus')}<span>Add camera</span></button>
        </div>
      </div>`;
    bindLive(root());
    return;
  }

  if (!cam) { root().innerHTML = ''; return; }

  const sourceLabel = cam.kind === 'webcam' ? 'usb webcam' : cam.kind;
  root().innerHTML = `
    <div class="wall">
      <article class="focus panel">
        <header class="focus-head">
          <div class="focus-id">
            <h2 id="focus-name">${esc(cam.name)}</h2>
            <p class="meta mono" id="focus-meta">${esc(sourceLabel)} · ${esc(cam.source)}</p>
          </div>
          <div class="focus-clock">
            <div class="rec" id="focus-rec"><span class="lamp"></span><span class="mono">REC</span></div>
            <time class="timecode mono" id="focus-timecode" aria-label="Recording time">00:00:00</time>
          </div>
        </header>
        <div class="stage" id="focus-stage">
          <canvas class="overlay" id="focus-overlay" role="img" aria-label="Live feed from ${esc(cam.name)}"></canvas>
          <span class="tick tl"></span><span class="tick tr"></span>
          <span class="tick bl"></span><span class="tick br"></span>
          <div class="stage-note" id="stage-note" hidden></div>
          <div class="stage-hint" id="stage-hint">drag a box to identify</div>
        </div>
        <div class="inspect" id="focus-inspect" hidden></div>
        <footer class="focus-foot" id="focus-foot">
          <span class="stat">status <b id="stat-status">—</b></span>
          <span class="stat">frames <b id="stat-frames">0</b></span>
          <span class="stat">rate <b id="stat-fps">0 fps</b></span>
          <span class="stat">objects <b id="stat-objects">0</b></span>
          <span class="stat">faces <b id="stat-faces">0</b></span>
        </footer>
      </article>

      <aside class="fleet panel">
        <div class="section-head">
          <h3>Cameras</h3>
          <span class="count mono">${state.cameras.length}</span>
        </div>
        <div class="fleet-list" id="fleet-list"></div>
        <div class="fleet-block">
          <div class="section-head">
            <h3>Seen now</h3>
            <span class="count mono" id="readout-count">0</span>
          </div>
          <div class="readout" id="readout"></div>
        </div>
        <div class="fleet-block">
          <div class="section-head">
            <h3>Detection</h3>
            <a href="#/settings" class="mono" style="font-size:var(--t-11)">Tune</a>
          </div>
          <div class="kv">
            <div><span>Objects</span><b>YOLOv10n</b></div>
            <div><span>Faces</span><b>SCRFD</b></div>
            <div><span>Identity</span><b>ArcFace</b></div>
            <div><span>Object ≥</span><b>${Number(state.settings.objectConfidence ?? 0.45).toFixed(2)}</b></div>
            <div><span>Match ≥</span><b>${Number(state.settings.matchThreshold ?? 0.42).toFixed(2)}</b></div>
            <div><span>Gallery</span><b>${state.gallerySize} sample${state.gallerySize === 1 ? '' : 's'}</b></div>
          </div>
        </div>
      </aside>
    </div>

    <section class="recent">
      <div class="section-head">
        <h2>Latest activity</h2>
        <a href="#/events" class="mono" style="font-size:var(--t-11)">All events</a>
      </div>
      <div class="rows" id="recent-rows"></div>
    </section>`;

  liveEls = {
    stage: $('#focus-stage'),
    canvas: $('#focus-overlay'),
    note: $('#stage-note'),
    hint: $('#stage-hint'),
    inspect: $('#focus-inspect'),
  };

  if (mark.camId !== cam.id) resetMark(cam.id);

  bindLive(document);
  renderFleet();
  renderReadout();
  renderRecent();
  observeStage();
  bindMarkGestures();
  renderInspect();
  startFeed(cam.id);
}

function bindLive(scope) {
  $$('[data-action]', scope).forEach((el) => {
    el.onclick = () => {
      const action = el.dataset.action;
      if (action === 'add-camera') openAddCamera();
    };
  });
}

function renderFleet() {
  const list = $('#fleet-list');
  if (!list) return;
  list.innerHTML = state.cameras.map((cam) => {
    const st = cam.state || {};
    const tone = st.status === 'live' ? 'live' : st.status === 'error' ? 'error' : st.status === 'starting' ? 'warn' : 'idle';
    return `
      <button class="fleet-row" type="button" role="option" aria-selected="${cam.id === state.selectedId}"
              data-cam="${esc(cam.id)}" ${cam.enabled ? '' : 'data-disabled="1"'}>
        <span class="dot" data-tone="${tone}"></span>
        <span class="fleet-name">${esc(cam.name)}</span>
        <span class="fleet-fps">${st.status === 'live' ? `${(st.fps || 0).toFixed(0)} fps` : esc(st.status || 'off')}</span>
      </button>`;
  }).join('');

  $$('.fleet-row', list).forEach((btn) => {
    btn.onclick = () => {
      state.selectedId = btn.dataset.cam;
      liveSig = '';
      renderLive({ full: true });
    };
  });
}

function renderReadout() {
  const host = $('#readout');
  if (!host) return;
  const cam = selectedCamera();
  const a = cam ? state.detections.get(cam.id) : null;
  const fresh = a && Date.now() - a.ts < 6000;

  const rows = [];
  if (fresh) {
    for (const f of a.faces) {
      rows.push({
        label: f.name || 'Unknown face',
        tone: f.personId ? 'known' : 'unknown',
        val: f.similarity != null ? f.similarity.toFixed(2) : '—',
      });
    }
    for (const o of a.objects) {
      if (o.label === 'person' && a.faces.length) continue;
      rows.push({
        label: o.label,
        tone: 'object',
        val: o.score.toFixed(2),
        note: o.refined
          ? `Re-scored by CLIP. The detector said "${o.detectorLabel}" ${o.detectorScore.toFixed(2)}; the detector only knows 80 COCO classes.`
          : null,
      });
    }
  }

  $('#readout-count').textContent = String(rows.length);

  if (!rows.length) {
    host.innerHTML = `<p class="quiet" style="font-size:var(--t-12);padding:6px 0">
      ${state.models.status === 'ready' ? 'Nothing detected in this frame.' : 'Detection models are loading.'}
    </p>`;
    return;
  }

  host.innerHTML = rows.slice(0, 8).map((r) => `
    <div class="readout-row"${r.note ? ` title="${esc(r.note)}"` : ''}>
      <span class="readout-label">
        <span class="swatch" data-tone="${r.tone === 'object' ? 'object' : r.tone === 'unknown' ? 'unknown' : ''}"></span>
        <span>${esc(r.label)}</span>
      </span>
      <span class="readout-val">${esc(r.val)}</span>
    </div>`).join('');
}

function updateLiveDynamic() {
  const cam = selectedCamera();
  if (!cam || !liveEls) return;
  const st = cam.state || {};
  const a = state.detections.get(cam.id);

  const set = (sel, text) => { const el = $(sel); if (el) el.textContent = text; };

  set('#stat-status', st.status === 'live' ? 'live' : st.status || 'off');
  set('#stat-frames', (st.frameCount || 0).toLocaleString());
  set('#stat-fps', `${(st.fps || 0).toFixed(0)} fps`);
  set('#stat-objects', String(a ? a.objects.length : 0));
  set('#stat-faces', String(a ? a.faces.length : 0));

  const rec = $('#focus-rec');
  if (rec) rec.style.visibility = st.status === 'live' ? 'visible' : 'hidden';

  const t0 = state.liveSince.get(cam.id);
  set('#focus-timecode', t0 && st.status === 'live' ? hhmmss(Date.now() - t0) : '00:00:00');

  // stage note for non-live cameras
  const note = $('#stage-note');
  if (note) {
    const problem = st.status !== 'live';
    note.hidden = !problem;
    if (problem) {
      const title = st.status === 'starting' ? 'Opening the camera…'
        : st.status === 'error' ? 'Camera unavailable'
          : st.status === 'stopped' ? (cam.enabled ? 'Capture stopped' : 'Capture disabled')
            : 'Waiting for the first frame';
      note.innerHTML = `<strong>${esc(title)}</strong>
        <span>${esc(st.message || (cam.kind === 'webcam' ? cam.source : 'check the stream address'))}</span>
        <span class="mono">${esc(st.status === 'error' ? 'retrying automatically' : 'isee · offline')}</span>`;
    }
  }

  renderReadout();
  if ($('#fleet-list')) updateFleetDots();
}

function updateFleetDots() {
  $$('#fleet-list .fleet-row').forEach((btn) => {
    const cam = cameraById(btn.dataset.cam);
    if (!cam) return;
    const st = cam.state || {};
    const tone = st.status === 'live' ? 'live' : st.status === 'error' ? 'error' : st.status === 'starting' ? 'warn' : 'idle';
    const dot = $('.dot', btn);
    if (dot) dot.dataset.tone = tone;
    const fps = $('.fleet-fps', btn);
    if (fps) fps.textContent = st.status === 'live' ? `${(st.fps || 0).toFixed(0)} fps` : (st.status || 'off');
  });
}

/* stage rendering ---------------------------------------------------- */

const cssVar = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};
const OVERLAY = {
  object: cssVar('--overlay-object', '#6FE3C0'),
  known: cssVar('--overlay-known', '#12574B'),
  unknown: cssVar('--overlay-unknown', '#B32D22'),
  stage: cssVar('--stage', '#000000'),
};

let stageObserver = null;
let stageTimer = null;

/** Live feed plumbing: read the MJPEG stream with fetch so we can abort it. */
const feed = { abort: null, bitmap: null, lastAt: 0, retries: 0, view: null };

/* ------------------------------------------------------------------ */
/* mark a region and identify it                                       */
/* ------------------------------------------------------------------ */

const mark = {
  camId: null, box: null, result: null, error: null,
  loading: false, dragging: false, r1: null, r2: null,
};

function resetMark(camId) {
  mark.camId = camId;
  mark.box = null;
  mark.result = null;
  mark.error = null;
  mark.loading = false;
  mark.dragging = false;
  mark.r1 = null;
  mark.r2 = null;
}

function stagePoint(e) {
  const r = liveEls.canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function toNormalized(p) {
  const v = feed.view;
  if (!v || !v.dw || !v.dh) return null;
  return { x: (p.x - v.ox) / v.dw, y: (p.y - v.oy) / v.dh };
}

function bindMarkGestures() {
  const cv = liveEls.canvas;
  if (!cv) return;
  const move = (e) => {
    if (!mark.dragging) return;
    mark.r2 = stagePoint(e);
    paintStage();
  };
  cv.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!feed.bitmap) return;
    mark.dragging = true;
    mark.r1 = stagePoint(e);
    mark.r2 = { ...mark.r1 };
    try { cv.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });
  cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerup', () => {
    if (!mark.dragging) return;
    mark.dragging = false;
    const a = mark.r1;
    const b = mark.r2;
    mark.r1 = null;
    mark.r2 = null;
    if (!a || !b) return;
    const px = Math.abs(b.x - a.x);
    const py = Math.abs(b.y - a.y);
    if (px < 12 || py < 12) { // a click, not a drag: clear the previous mark
      mark.box = null; mark.result = null; mark.error = null;
      renderInspect();
      paintStage();
      return;
    }
    const n1 = toNormalized({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) });
    const n2 = toNormalized({ x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) });
    if (!n1 || !n2) return;
    const x0 = Math.max(0, Math.min(1, n1.x));
    const y0 = Math.max(0, Math.min(1, n1.y));
    const x1 = Math.max(0, Math.min(1, n2.x));
    const y1 = Math.max(0, Math.min(1, n2.y));
    if (x1 - x0 < 0.015 || y1 - y0 < 0.015) return;
    mark.box = [x0, y0, x1 - x0, y1 - y0];
    mark.result = null;
    mark.error = null;
    if (liveEls.hint) liveEls.hint.hidden = true;
    runInspect();
  });
  cv.addEventListener('pointercancel', () => {
    mark.dragging = false; mark.r1 = null; mark.r2 = null;
    paintStage();
  });
}

async function runInspect() {
  if (!mark.box || !mark.camId) return;
  mark.loading = true;
  mark.error = null;
  renderInspect();
  paintStage();
  try {
    mark.result = await api(`/api/cameras/${mark.camId}/inspect`, {
      method: 'POST',
      body: { box: mark.box },
    });
  } catch (err) {
    mark.error = err.message;
  }
  mark.loading = false;
  renderInspect();
  paintStage();
}

function inspectsHtml() {
  if (mark.loading) {
    return `<div class="inspect-crop skeleton"></div>
      <div class="inspect-body">
        <div class="inspect-kicker">Marked region</div>
        <div class="skeleton" style="width:180px;height:14px;margin-top:6px"></div>
        <div class="skeleton" style="width:120px;height:10px;margin-top:6px"></div>
      </div>`;
  }
  if (mark.error) {
    return `<div class="inspect-body">
        <div class="inspect-kicker">Marked region</div>
        <div class="inspect-primary">Could not identify</div>
        <div class="inspect-sub">${esc(mark.error)}</div>
      </div>
      <div class="inspect-actions">
        <button class="btn btn-sm" type="button" data-inspect="retry">Try again</button>
        <button class="btn btn-sm btn-ghost" type="button" data-inspect="clear">Clear</button>
      </div>`;
  }
  const res = mark.result;
  if (!res) return '';

  const g = res.guess || { label: 'Nothing recognised', confidence: 0, detail: '' };
  const conf = g.confidence ? Number(g.confidence).toFixed(2) : '';
  const face = (res.faces || [])[0];

  const object = (res.objects || [])[0];
  const others = (res.objects || [])
    .slice(1, 4)
    .map((o) => `<span class="chip">${esc(o.label)} ${o.score.toFixed(2)}</span>`);

  if (object && object.refined) {
    others.unshift(`<span class="chip" title="The detector is limited to 80 COCO classes; CLIP re-scored this crop.">was ${esc(object.detectorLabel)}</span>`);
  }
  if (object && object.ambiguous) {
    others.push('<span class="chip">unsure</span>');
  }
  const vocab = (res.vocabulary || []).filter((v) => v.label !== g.label).slice(0, 2)
    .map((v) => `<span class="chip">also ${esc(v.label)} ${v.score.toFixed(2)}</span>`);

  const textBlock = res.text
    ? `<div class="inspect-text" title="Read with OCR at ${res.textConfidence || 0}% confidence">
         <span class="inspect-text-label">text${res.textConfidence ? ` · ${res.textConfidence}%` : ''}${res.textConfidence && res.textConfidence < 60 ? ' · unsure' : ''}</span>${esc(res.text)}
       </div>`
    : '';

  return `<img class="inspect-crop" src="${esc(res.crop)}" alt="Marked region on ${esc(res.cameraName)}">
    <div class="inspect-body">
      <div class="inspect-kicker">Marked region</div>
      <div class="inspect-primary">${esc(g.label)}${conf ? ` <b>${conf}</b>` : ''}</div>
      <div class="inspect-sub">${esc(g.detail || '')}</div>
      ${textBlock}
      ${others.length || vocab.length ? `<div class="inspect-chips">${others.join('')}${vocab.join('')}</div>` : ''}
    </div>
    <div class="inspect-actions">
      ${face && !face.personId
        ? '<button class="btn btn-sm btn-primary" type="button" data-inspect="name">Name this face</button>'
        : ''}
      <button class="btn btn-sm btn-ghost" type="button" data-inspect="clear">Clear</button>
    </div>`;
}

function renderInspect() {
  const host = liveEls && liveEls.inspect;
  if (!host) return;
  const active = !!(mark.box || mark.loading || mark.result || mark.error);
  host.hidden = !active;
  if (!active) { host.innerHTML = ''; return; }
  host.innerHTML = inspectsHtml();
  host.querySelectorAll('[data-inspect]').forEach((btn) => {
    btn.onclick = () => {
      const action = btn.dataset.inspect;
      if (action === 'clear') {
        mark.box = null; mark.result = null; mark.error = null; mark.loading = false;
        renderInspect();
        paintStage();
      } else if (action === 'retry') {
        runInspect();
      } else if (action === 'name') {
        const face = mark.result && mark.result.faces && mark.result.faces[0];
        openEnroll({ focusBox: mark.box, faceThumb: face && face.thumb });
      }
    };
  });
}

function stopFeed() {
  if (feed.abort) { try { feed.abort.abort(); } catch { /* already gone */ } }
  feed.abort = null;
  if (feed.bitmap) { try { feed.bitmap.close(); } catch { /* already gone */ } }
  feed.bitmap = null;
  feed.lastAt = 0;
  feed.retries = 0;
  feed.view = null;
}

function indexOfMarker(buf, from, second) {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === 0xff && buf[i + 1] === second) return i;
  }
  return -1;
}

async function showFrame(jpeg, ctrl) {
  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
  } catch { return; }
  if (feed.abort !== ctrl) { bmp.close(); return; }
  if (feed.bitmap) { try { feed.bitmap.close(); } catch { /* ignore */ } }
  feed.bitmap = bmp;
  feed.lastAt = Date.now();
  feed.retries = 0;
  paintStage();
}

function retryFeed(camId, ctrl) {
  if (feed.abort !== ctrl) return;
  feed.retries = Math.min(feed.retries + 1, 5);
  const delay = Math.min(8000, 600 * 2 ** (feed.retries - 1));
  setTimeout(() => {
    if (state.route === 'live' && state.selectedId === camId) startFeed(camId);
  }, delay);
}

async function startFeed(camId) {
  stopFeed();
  const ctrl = new AbortController();
  feed.abort = ctrl;

  let res;
  try {
    res = await fetch(`/stream/${camId}.mjpg?${Date.now()}`, { signal: ctrl.signal, cache: 'no-store' });
  } catch { return retryFeed(camId, ctrl); }
  if (!res.ok || !res.body) return retryFeed(camId, ctrl);

  const reader = res.body.getReader();
  let pending = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (feed.abort !== ctrl) return;

      const merged = new Uint8Array(pending.length + value.length);
      merged.set(pending, 0);
      merged.set(value, pending.length);
      pending = merged;

      for (;;) {
        const start = indexOfMarker(pending, 0, 0xd8);
        if (start < 0) { pending = pending.slice(Math.max(0, pending.length - 1)); break; }
        const end = indexOfMarker(pending, start + 2, 0xd9);
        if (end < 0) {
          if (start > 0) pending = pending.slice(start);
          break;
        }
        const jpeg = pending.slice(start, end + 2);
        pending = pending.slice(end + 2);
        await showFrame(jpeg, ctrl);
        if (feed.abort !== ctrl) return;
      }
      if (pending.length > 8 * 1024 * 1024) pending = new Uint8Array(0);
    }
  } catch (err) {
    if (ctrl.signal.aborted) return;
  }
  retryFeed(camId, ctrl);
}

function observeStage() {
  if (stageObserver) stageObserver.disconnect();
  if (!liveEls || !liveEls.stage) return;
  stageObserver = new ResizeObserver(() => paintStage());
  stageObserver.observe(liveEls.stage);
  startStageLoop();
}

/** A timer, not rAF: rAF stalls when the tab is hidden. */
function startStageLoop() {
  if (stageTimer) return;
  stageTimer = setInterval(paintStage, 100);
  paintStage();
}

function stopStageLoop() {
  if (stageTimer) clearInterval(stageTimer);
  stageTimer = null;
}

function paintStage() {
  if (state.route !== 'live' || !liveEls) return;
  const { canvas: cv, stage } = liveEls;
  if (!cv || !stage) return;

  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!w || !h) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.round(w * dpr);
  const ch = Math.round(h * dpr);
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }

  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = OVERLAY.stage;
  ctx.fillRect(0, 0, w, h);

  const bmp = feed.bitmap;
  if (!bmp) return;
  const vw = bmp.width;
  const vh = bmp.height;
  if (!vw || !vh) return;

  const k = Math.min(w / vw, h / vh);
  const dw = vw * k;
  const dh = vh * k;
  const ox = (w - dw) / 2;
  const oy = (h - dh) / 2;
  feed.view = { ox, oy, dw, dh };
  try { ctx.drawImage(bmp, ox, oy, dw, dh); } catch { return; }

  // hug the feed's own aspect so a 4:3 camera is not stranded in a 16:9 window
  const ar = Math.min(2.4, Math.max(1, vw / vh));
  if (Math.abs(Number(stage.dataset.ar || 0) - ar) > 0.01) {
    stage.dataset.ar = String(ar);
    stage.style.aspectRatio = String(ar);
  }

  if (mark.box) {
    const mx = ox + mark.box[0] * dw;
    const my = oy + mark.box[1] * dh;
    const mw = mark.box[2] * dw;
    const mh = mark.box[3] * dh;
    ctx.save();
    ctx.strokeStyle = OVERLAY.known;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(mx + 0.5, my + 0.5, mw, mh);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    const t = 9;
    for (const [cxp, cyp, dx, dy] of [[mx, my, 1, 1], [mx + mw, my, -1, 1], [mx, my + mh, 1, -1], [mx + mw, my + mh, -1, -1]]) {
      ctx.beginPath();
      ctx.moveTo(cxp + dx * t, cyp);
      ctx.lineTo(cxp, cyp);
      ctx.lineTo(cxp, cyp + dy * t);
      ctx.stroke();
    }
    ctx.restore();
  }

  if (mark.dragging && mark.r1 && mark.r2) {
    const rx = Math.min(mark.r1.x, mark.r2.x);
    const ry = Math.min(mark.r1.y, mark.r2.y);
    const rw = Math.abs(mark.r2.x - mark.r1.x);
    const rh = Math.abs(mark.r2.y - mark.r1.y);
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
    ctx.restore();
  }

  const cam = selectedCamera();
  const a = cam ? state.detections.get(cam.id) : null;
  if (!a || Date.now() - a.ts > 4000) return;

  const label = (text, x, y, bg) => {
    ctx.font = '500 11px "IBM Plex Mono", monospace';
    const tw = ctx.measureText(text).width + 12;
    const th = 18;
    const bx = Math.max(2, Math.min(w - tw - 2, x));
    const by = Math.max(2, y - th - 4);
    ctx.fillStyle = bg;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(bx, by, tw, th, 3);
      ctx.fill();
    } else {
      ctx.fillRect(bx, by, tw, th);
    }
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 6, by + th / 2 + 0.5);
  };

  for (const o of a.objects) {
    if (o.label === 'person' && a.faces.length) continue;
    const [nx, ny, nw, nh] = o.box;
    const x = ox + nx * dw;
    const y = oy + ny * dh;
    const bw = nw * dw;
    const bh = nh * dh;
    ctx.strokeStyle = OVERLAY.object;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, y + 0.5, bw, bh);
    label(`${o.label} ${o.score.toFixed(2)}`, x, y, OVERLAY.known);
  }

  for (const f of a.faces) {
    const [nx, ny, nw, nh] = f.box;
    const x = ox + nx * dw;
    const y = oy + ny * dh;
    const bw = nw * dw;
    const bh = nh * dh;
    ctx.strokeStyle = f.personId ? OVERLAY.known : OVERLAY.unknown;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 0.5, y + 0.5, bw, bh);
    label(
      f.personId ? `${f.name} ${(f.similarity || 0).toFixed(2)}` : `unknown ${(f.similarity || 0).toFixed(2)}`,
      x, y, f.personId ? OVERLAY.known : OVERLAY.unknown,
    );
  }
}


/* recent activity ---------------------------------------------------- */

function eventRow(ev) {
  const thumb = ev.snapshot
    ? `<img class="row-thumb" src="${esc(ev.snapshot)}" alt="" loading="lazy">`
    : `<span class="row-thumb" aria-hidden="true"></span>`;
  const kind = ev.kind === 'face' ? 'Face' : 'Object';
  return `
    <div class="row">
      ${thumb}
      <div class="row-main">
        <div class="row-title">${esc(ev.label)}</div>
        <div class="row-sub">${kind} · ${esc(ev.cameraName || 'camera')}</div>
      </div>
      <div class="row-side">${ev.score != null ? ev.score.toFixed(2) : ''} <span>${esc(ago(ev.ts))}</span></div>
    </div>`;
}

function renderRecent() {
  const host = $('#recent-rows');
  if (!host) return;
  if (!state.events.length) {
    host.innerHTML = `<p class="quiet" style="font-size:var(--t-13);padding:var(--s3) 0">
      Nothing recorded yet. Move something in front of the camera — detections appear here and in the event log.</p>`;
    return;
  }
  host.innerHTML = state.events.slice(0, 5).map(eventRow).join('');
}

/* ================================================================== */
/* PEOPLE                                                              */
/* ================================================================== */

function renderPeople() {
  const people = state.people || [];
  const s = state.stats || {};
  root().innerHTML = `
    <div class="view-head">
      <div>
        <p>Faces enrolled here are matched live on every camera. Two or three angles per person keeps false matches down.</p>
      </div>
      <button class="btn btn-primary" type="button" id="enroll-btn">${icon('plus')}<span>Enroll a person</span></button>
    </div>

    <dl class="ledger">
      <div><dt>People</dt><dd>${s.people ?? people.length}</dd></div>
      <div><dt>Face samples</dt><dd>${s.samples ?? state.gallerySize}</dd></div>
      <div><dt>Recognitions today</dt><dd>${Math.max(0, (s.facesToday ?? 0) - (s.unknownToday ?? 0))}</dd></div>
      <div><dt>Unknown today</dt><dd>${s.unknownToday ?? 0}</dd></div>
    </dl>

    ${people.length ? `
      <div class="people-grid">
        ${people.map((p) => {
          const thumb = p.faces && p.faces[0] ? `/shots/${esc(p.faces[0].thumb)}` : null;
          return `
            <article class="person" data-person="${esc(p.id)}">
              <div class="person-thumb">
                ${thumb ? `<img src="${thumb}" alt="Enrolled photo of ${esc(p.name)}" loading="lazy">` : ''}
                <span class="tag">${String(p.faces ? p.faces.length : 0).padStart(2, '0')} samples</span>
              </div>
              <div class="person-body">
                <div style="min-width:0">
                  <div class="person-name">${esc(p.name)}</div>
                  <div class="person-meta mono">since ${esc(new Date(p.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</div>
                </div>
                <div class="person-actions">
                  <button class="icon-btn" type="button" data-sample="${esc(p.id)}" title="Add another angle" aria-label="Add another face sample for ${esc(p.name)}">${icon('plus')}</button>
                  <button class="icon-btn is-danger" type="button" data-remove="${esc(p.id)}" title="Remove person" aria-label="Remove ${esc(p.name)}">${icon('trash')}</button>
                </div>
              </div>
            </article>`;
        }).join('')}
      </div>` : `
      <div class="panel">
        <div class="empty">
          <strong>No one enrolled yet</strong>
          <p>Face recognition works by comparing a live face with a small gallery of enrolled samples.
             Add yourself first — look straight at the camera in even light.</p>
          <button class="btn btn-primary" type="button" data-action="enroll">${icon('user')}<span>Enroll a person</span></button>
        </div>
      </div>`}`;

  const enroll = () => openEnroll();
  $('#enroll-btn')?.addEventListener('click', enroll);
  const emptyBtn = $('[data-action="enroll"]');
  if (emptyBtn) emptyBtn.onclick = enroll;

  $$('[data-remove]').forEach((btn) => {
    btn.onclick = () => {
      const p = state.people.find((x) => x.id === btn.dataset.remove);
      if (!p) return;
      confirmDialog({
        title: `Remove ${p.name}?`,
        message: 'Their face samples are deleted and future frames will report them as unknown. Recorded events are kept.',
        onConfirm: async () => {
          await api(`/api/people/${p.id}`, { method: 'DELETE' });
          state.people = state.people.filter((x) => x.id !== p.id);
          state.gallerySize = Math.max(0, state.gallerySize - (p.faces ? p.faces.length : 0));
          renderChrome();
          renderPeople();
          toast(`${p.name} removed`);
        },
      });
    };
  });

  $$('[data-sample]').forEach((btn) => {
    btn.onclick = () => {
      const p = state.people.find((x) => x.id === btn.dataset.sample);
      if (p) openEnroll({ person: p });
    };
  });
}

/* ================================================================== */
/* EVENTS                                                              */
/* ================================================================== */

const filters = { cameraId: '', kind: '', label: '' };

function matchesFilters(ev) {
  if (filters.cameraId && ev.cameraId !== filters.cameraId) return false;
  if (filters.kind && ev.kind !== filters.kind) return false;
  if (filters.label && !(ev.label || '').toLowerCase().includes(filters.label.toLowerCase())) return false;
  return true;
}

async function renderEvents() {
  root().innerHTML = `
    <div class="panel filters">
      <div class="field">
        <label for="f-camera">Camera</label>
        <select class="select" id="f-camera">
          <option value="">All cameras</option>
          ${state.cameras.map((c) => `<option value="${esc(c.id)}" ${filters.cameraId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="f-kind">Kind</label>
        <select class="select" id="f-kind">
          <option value="">Everything</option>
          <option value="face" ${filters.kind === 'face' ? 'selected' : ''}>Faces</option>
          <option value="object" ${filters.kind === 'object' ? 'selected' : ''}>Objects</option>
        </select>
      </div>
      <div class="field grow">
        <label for="f-label">Label</label>
        <input class="input" id="f-label" type="search" placeholder="person name, dog, laptop…" value="${esc(filters.label)}">
      </div>
      <button class="btn" type="button" id="f-clear">Clear</button>
    </div>
    <div class="panel" style="padding: var(--s2) var(--s5) var(--s4)">
      <div class="rows" id="events-rows"></div>
    </div>`;

  const load = async () => {
    state.loading.events = true;
    renderEventsList();
    const q = new URLSearchParams();
    if (filters.cameraId) q.set('cameraId', filters.cameraId);
    if (filters.kind) q.set('kind', filters.kind);
    if (filters.label) q.set('label', filters.label);
    q.set('limit', '80');
    try {
      state.events = await api(`/api/events?${q.toString()}`);
    } catch (err) {
      toast(err.message, 'error');
      state.events = [];
    }
    state.loading.events = false;
    renderEventsList();
    renderChrome();
  };

  $('#f-camera').onchange = (e) => { filters.cameraId = e.target.value; load(); };
  $('#f-kind').onchange = (e) => { filters.kind = e.target.value; load(); };
  $('#f-label').oninput = (e) => {
    filters.label = e.target.value.trim();
    clearTimeout($('#f-label')._t);
    $('#f-label')._t = setTimeout(load, 260);
  };
  $('#f-clear').onclick = () => {
    filters.cameraId = ''; filters.kind = ''; filters.label = '';
    renderEvents();
  };

  await load();
}

function renderEventsList() {
  const host = $('#events-rows');
  if (!host) return;
  if (state.loading.events && !state.events.length) {
    host.innerHTML = Array.from({ length: 5 }, () => `
      <div class="event-row">
        <div class="skeleton" style="width:96px;height:60px"></div>
        <div class="event-main">
          <div class="skeleton" style="width:180px;height:14px;margin-bottom:6px"></div>
          <div class="skeleton" style="width:120px;height:11px"></div>
        </div>
      </div>`).join('');
    return;
  }
  if (!state.events.length) {
    host.innerHTML = `
      <div class="empty">
        <strong>No events match</strong>
        <p>Detections are recorded when something new appears on a camera. Try clearing the filters, or let the camera run for a minute.</p>
      </div>`;
    return;
  }
  host.innerHTML = state.events.map((ev) => `
    <div class="event-row">
      ${ev.snapshot
        ? `<img class="event-thumb" src="${esc(ev.snapshot)}" alt="" loading="lazy">`
        : `<span class="event-thumb" aria-hidden="true"></span>`}
      <div class="event-main">
        <div class="event-title">
          <span>${esc(ev.label)}</span>
          <span class="chip" data-tone="${ev.kind === 'face' ? 'accent' : ''}">${ev.kind === 'face' ? 'Face' : 'Object'}</span>
        </div>
        <div class="event-sub">${esc(ev.cameraName || 'camera')} · ${esc(dateTime(ev.ts))}</div>
      </div>
      <div class="event-side">
        <div class="event-time">${esc(clock(new Date(ev.ts)))}</div>
        <div class="event-conf">${ev.score != null ? ev.score.toFixed(2) : '—'}</div>
      </div>
    </div>`).join('');
}

/* ================================================================== */
/* SETTINGS                                                            */
/* ================================================================== */

const MCP_TOOLS = [
  ['list_cameras', 'Fleet health and last detections'],
  ['capture_frame', 'Current frame, annotated'],
  ['identify_objects', 'COCO object labels + boxes'],
  ['recognize_faces', 'Named matches with similarity'],
  ['enroll_person', 'Add a person from camera or image'],
  ['query_events', 'Search the event log'],
  ['add_camera', 'Register a webcam or RTSP stream'],
];

function renderSettings() {
  const s = state.settings;
  const endpoint = `http://127.0.0.1:${location.port || '7373'}/mcp`;

  root().innerHTML = `
    <div class="settings-grid">
      <div>
        <section class="panel card">
          <div class="section-head">
            <h2>Cameras</h2>
            <button class="btn btn-sm" type="button" id="settings-add">${icon('plus')}<span>Add</span></button>
          </div>
          <div id="cam-list"></div>
        </section>

        <section class="panel card">
          <div class="section-head"><h2>Detection</h2><span class="count mono">${state.models.status}</span></div>
          <div id="sliders"></div>
        </section>

        <section class="panel card">
          <div class="section-head"><h2>Recognition</h2><span class="count mono">clip · ocr</span></div>
          <div class="toggle-row">
            <div>
              <div class="toggle-title">Re-score uncertain labels</div>
              <p class="slider-desc">The object detector only knows 80 classes. When it is unsure, CLIP re-scores the crop against the vocabulary below.</p>
            </div>
            <button class="switch" type="button" role="switch" id="refine-toggle"
                    aria-checked="${state.settings.refineObjects !== false}" aria-label="Re-score uncertain labels"></button>
          </div>
          <div class="field" style="margin-top:var(--s4)">
            <label for="vocab">Vocabulary</label>
            <textarea class="input textarea" id="vocab" rows="8" spellcheck="false">${esc((state.settings.vocabulary || []).join('\n'))}</textarea>
            <p class="hint">One phrase per line. Add “a sharpie” or “a mug” — words the detector cannot say. Marked regions are described from this list.</p>
          </div>
          <div style="display:flex;gap:var(--s2);margin-top:var(--s3)">
            <button class="btn btn-sm" id="vocab-save" type="button">Save vocabulary</button>
            <button class="btn btn-sm btn-ghost" id="vocab-reset" type="button">Reset</button>
          </div>
        </section>
      </div>

      <div>
        <section class="panel card">
          <div class="section-head"><h2>MCP server</h2><span class="chip" data-tone="accent">streamable http</span></div>
          <p class="quiet" style="font-size:var(--t-12);margin-bottom:var(--s3)">
            Any MCP client on this machine can watch the same cameras, read the event log and enrol faces.
          </p>
          <div class="endpoint">
            <code id="mcp-endpoint">${esc(endpoint)}</code>
            <button class="icon-btn" type="button" id="copy-endpoint" aria-label="Copy MCP endpoint">${icon('copy')}</button>
          </div>
          <ul class="tool-list">
            ${MCP_TOOLS.map(([name, desc]) => `<li><code>${name}</code><small>${esc(desc)}</small></li>`).join('')}
          </ul>
        </section>

        <section class="panel card">
          <div class="section-head"><h2>This machine</h2></div>
          <ul class="tool-list">
            <li><span class="quiet">Models</span><span class="mono" style="font-size:var(--t-12)">YOLOv10n · SCRFD · ArcFace</span></li>
            <li><span class="quiet">Gallery</span><span class="mono" style="font-size:var(--t-12)">${state.gallerySize} sample${state.gallerySize === 1 ? '' : 's'}</span></li>
            <li><span class="quiet">People</span><span class="mono" style="font-size:var(--t-12)">${state.people.length}</span></li>
          </ul>
        </section>
      </div>
    </div>`;

  renderCameraList();
  renderSliders();
  bindRecognitionSettings();

  $('#settings-add').onclick = () => openAddCamera();
  $('#copy-endpoint').onclick = async () => {
    try {
      await navigator.clipboard.writeText(endpoint);
      toast('MCP endpoint copied');
    } catch {
      toast('Copy failed — select the address manually', 'warn');
    }
  };
}

function renderCameraList() {
  const host = $('#cam-list');
  if (!host) return;
  if (!state.cameras.length) {
    host.innerHTML = `<div class="empty" style="padding:var(--s4) 0">
      <strong>No cameras</strong><p>Add a USB webcam or an RTSP stream.</p></div>`;
    return;
  }
  host.innerHTML = state.cameras.map((cam) => {
    const st = cam.state || {};
    return `
      <div class="cam-row" data-cam="${esc(cam.id)}">
        <div style="min-width:0">
          <div class="cam-name">${esc(cam.name)}</div>
          <div class="cam-src">${esc(cam.kind)} · ${esc(cam.source)}</div>
        </div>
        <div class="cam-controls">
          <label class="rate" title="Detection rate">
            <input class="input mono" type="number" min="0.2" max="15" step="0.5" value="${cam.detectFps}"
                   data-rate="${esc(cam.id)}" aria-label="Detection rate for ${esc(cam.name)}">
            <span>fps</span>
          </label>
          <button class="switch" type="button" role="switch" aria-checked="${cam.enabled}"
                  data-toggle="${esc(cam.id)}" aria-label="Enable ${esc(cam.name)}"></button>
        </div>
        <button class="icon-btn is-danger" type="button" data-del="${esc(cam.id)}" aria-label="Remove ${esc(cam.name)}">${icon('trash')}</button>
      </div>`;
  }).join('');

  $$('[data-toggle]', host).forEach((btn) => {
    btn.onclick = async () => {
      const cam = cameraById(btn.dataset.toggle);
      if (!cam) return;
      btn.disabled = true;
      try {
        const next = !cam.enabled;
        const updated = await api(`/api/cameras/${cam.id}`, { method: 'PATCH', body: { enabled: next } });
        cam.enabled = updated.enabled;
        btn.setAttribute('aria-checked', String(updated.enabled));
        renderChrome();
      } catch (err) { toast(err.message, 'error'); }
      btn.disabled = false;
    };
  });

  $$('[data-rate]', host).forEach((inp) => {
    inp.onchange = async () => {
      const cam = cameraById(inp.dataset.rate);
      if (!cam) return;
      const value = Math.min(15, Math.max(0.2, Number(inp.value) || 2));
      inp.value = value;
      try {
        const updated = await api(`/api/cameras/${cam.id}`, { method: 'PATCH', body: { detectFps: value } });
        cam.detectFps = updated.detectFps;
        toast(`${cam.name}: detection at ${updated.detectFps}/s`);
      } catch (err) { toast(err.message, 'error'); }
    };
  });

  $$('[data-del]', host).forEach((btn) => {
    btn.onclick = () => {
      const cam = cameraById(btn.dataset.del);
      if (!cam) return;
      confirmDialog({
        title: `Remove ${cam.name}?`,
        message: 'Capture stops and the camera is removed from the fleet. Recorded events stay in the log.',
        onConfirm: async () => {
          await api(`/api/cameras/${cam.id}`, { method: 'DELETE' });
          state.cameras = state.cameras.filter((c) => c.id !== cam.id);
          state.detections.delete(cam.id);
          pickSelected();
          liveSig = '';
          renderChrome();
          renderSettings();
          toast(`${cam.name} removed`);
        },
      });
    };
  });
}

const SLIDERS = [
  { key: 'objectConfidence', label: 'Object confidence', min: 0.05, max: 0.95, step: 0.01, fmt: (v) => v.toFixed(2),
    desc: 'Minimum score before an object is reported. Lower finds more, and more noise.' },
  { key: 'faceConfidence', label: 'Face detection confidence', min: 0.05, max: 0.95, step: 0.01, fmt: (v) => v.toFixed(2),
    desc: 'How certain the face detector must be before a box is drawn.' },
  { key: 'matchThreshold', label: 'Identity match threshold', min: 0.2, max: 0.85, step: 0.01, fmt: (v) => v.toFixed(2),
    desc: 'Cosine similarity needed to name a face. Above 0.45 is strict; below 0.35 is loose.' },
  { key: 'eventCooldownMs', label: 'Event cooldown', min: 0, max: 600000, step: 30000, fmt: (v) => `${Math.round(v / 1000)}s`,
    desc: 'Quiet period before the same label can be logged again from a camera.' },
];

function bindRecognitionSettings() {
  const toggle = $('#refine-toggle');
  if (toggle) {
    toggle.onclick = async () => {
      const next = toggle.getAttribute('aria-checked') !== 'true';
      toggle.disabled = true;
      try {
        state.settings = await api('/api/settings', { method: 'PATCH', body: { refineObjects: next } });
        toggle.setAttribute('aria-checked', String(state.settings.refineObjects !== false));
        toast(next ? 'CLIP will re-score uncertain labels' : 'Detector labels left as-is');
      } catch (err) { toast(err.message, 'error'); }
      toggle.disabled = false;
    };
  }

  const save = $('#vocab-save');
  if (save) {
    save.onclick = async () => {
      save.disabled = true;
      try {
        const lines = $('#vocab').value.split('\n').map((l) => l.trim()).filter(Boolean);
        state.settings = await api('/api/settings', { method: 'PATCH', body: { vocabulary: lines } });
        $('#vocab').value = (state.settings.vocabulary || []).join('\n');
        toast(`Vocabulary saved — ${state.settings.vocabulary.length} phrases`);
      } catch (err) { toast(err.message, 'error'); }
      save.disabled = false;
    };
  }

  const reset = $('#vocab-reset');
  if (reset) {
    reset.onclick = async () => {
      try {
        state.settings = await api('/api/settings', { method: 'PATCH', body: { vocabulary: [] } });
        $('#vocab').value = (state.settings.vocabulary || []).join('\n');
        toast('Vocabulary reset to the default list');
      } catch (err) { toast(err.message, 'error'); }
    };
  }
}

function renderSliders() {
  const host = $('#sliders');
  if (!host) return;
  host.innerHTML = SLIDERS.map((s) => {
    const v = Number(state.settings[s.key] ?? s.min);
    return `
      <div class="slider-row">
        <div class="slider-head">
          <label for="sl-${s.key}">${s.label}</label>
          <output for="sl-${s.key}" id="out-${s.key}" class="mono">${s.fmt(v)}</output>
        </div>
        <input type="range" id="sl-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}"
               value="${v}" aria-describedby="desc-${s.key}">
        <p class="slider-desc" id="desc-${s.key}">${s.desc}</p>
      </div>`;
  }).join('');

  for (const s of SLIDERS) {
    const input = $(`#sl-${s.key}`);
    if (!input) continue;
    input.oninput = () => {
      $(`#out-${s.key}`).textContent = s.fmt(Number(input.value));
    };
    input.onchange = async () => {
      const value = Number(input.value);
      try {
        state.settings = await api('/api/settings', { method: 'PATCH', body: { [s.key]: value } });
        $(`#out-${s.key}`).textContent = s.fmt(Number(state.settings[s.key]));
        toast(`${s.label.toLowerCase()} set to ${s.fmt(Number(state.settings[s.key]))}`);
      } catch (err) { toast(err.message, 'error'); }
    };
  }
}

/* ================================================================== */
/* MODALS                                                              */
/* ================================================================== */

/* add camera --------------------------------------------------------- */

async function openAddCamera() {
  let mode = 'webcam';
  let chosen = null;
  let scan = { status: 'idle', data: null, error: null };
  let tested = null;
  let probing = false;
  let webcamAutoName = '';

  const PRESETS = [
    ['auto', 'Detect automatically'],
    ['dahua', 'Dahua · NVR'],
    ['xmeye', 'XMeye · NETSurveillance DVR'],
    ['hikvision', 'Hikvision'],
    ['onvif', 'ONVIF · generic RTSP'],
    ['http', 'MJPEG over HTTP'],
    ['custom', 'Full URL'],
  ];

  const needsUrl = (preset) => preset === 'custom' || preset === 'http';

  openModal({
    title: 'Add a camera',
    size: 'lg',
    body: `
      <div class="acquire">
        <div class="segmented" role="group" aria-label="Camera type">
          <button type="button" data-mode="webcam" aria-pressed="true">USB webcam</button>
          <button type="button" data-mode="stream" aria-pressed="false">Network stream</button>
        </div>

        <div id="mode-webcam">
          <div class="field">
            <label>Devices on this computer</label>
            <div class="device-list" id="device-list">
              <div class="skeleton" style="height:44px"></div>
              <div class="skeleton" style="height:44px"></div>
            </div>
            <p class="hint" id="device-hint">Scanning for capture devices…</p>
          </div>
        </div>

        <div id="mode-stream" hidden>
          <section class="acq-scan">
            <div class="acq-head">
              <h3>On this network</h3>
              <span class="acq-meta mono" id="scan-meta">not scanned</span>
              <button class="btn btn-sm" id="scan-btn" type="button">${icon('refresh')}<span>Scan</span></button>
            </div>
            <div class="acq-rows" id="scan-rows" aria-live="polite">
              <p class="acq-empty">Scanning tells you which cameras this machine can reach, so nothing has to be typed from memory.</p>
            </div>
          </section>

          <section class="acq-form">
            <div class="acq-grid narrow">
              <div class="field">
                <label for="s-preset">Device type</label>
                <select class="select" id="s-preset">
                  ${PRESETS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
                </select>
              </div>
              <div class="field" id="cell-port">
                <label for="s-port">Port</label>
                <input class="input mono" id="s-port" value="554" inputmode="numeric" maxlength="5">
              </div>
            </div>

            <div class="field" id="cell-host">
              <label for="s-host">Host</label>
              <input class="input mono" id="s-host" placeholder="192.168.1.20" spellcheck="false" autocomplete="off">
            </div>

            <div class="acq-grid" id="cell-credentials">
              <div class="field">
                <label for="s-user">Username</label>
                <input class="input" id="s-user" spellcheck="false" autocomplete="off" placeholder="admin">
              </div>
              <div class="field">
                <label for="s-pass">Password</label>
                <div class="pass-wrap">
                  <input class="input" id="s-pass" type="password" autocomplete="new-password">
                  <button class="pass-eye" id="s-eye" type="button" aria-pressed="false">Show</button>
                </div>
              </div>
            </div>

            <div class="acq-grid" id="cell-stream">
              <div class="field">
                <label for="s-chan">Channel</label>
                <input class="input mono" id="s-chan" type="number" min="1" max="64" value="1">
              </div>
              <div class="field">
                <label for="s-quality">Stream</label>
                <select class="select" id="s-quality">
                  <option value="1">Sub — light for the detector</option>
                  <option value="0">Main — full resolution</option>
                </select>
              </div>
            </div>

            <div class="field" id="cell-url" hidden>
              <label for="s-url">Stream URL</label>
              <input class="input mono" id="s-url" placeholder="http://192.168.1.31:8080/video" spellcheck="false">
            </div>

            <p class="acq-derived mono" id="s-derived" aria-live="polite">—</p>
          </section>

          <section class="probe" id="probe">
            <div class="probe-stage" id="probe-stage">
              <span class="tick tl"></span><span class="tick tr"></span>
              <span class="tick bl"></span><span class="tick br"></span>
              <p class="probe-empty" id="probe-empty">NO FRAME</p>
              <img id="probe-img" alt="Frame from the camera" hidden>
            </div>
            <div class="probe-read">
              <span class="chip" id="probe-chip">untested</span>
              <p class="probe-msg" id="probe-msg">Test the address before adding it. One frame is the only proof that matters.</p>
              <p class="probe-note" id="probe-note" hidden></p>
            </div>
          </section>
        </div>

        <div class="acq-grid">
          <div class="field">
            <label for="c-name">Name</label>
            <input class="input" id="c-name" placeholder="Front door" maxlength="60">
          </div>
          <div class="field">
            <label for="c-rate">Detection rate</label>
            <input class="input mono" id="c-rate" type="number" min="0.2" max="15" step="0.5" value="2">
          </div>
        </div>

        <p class="acq-error" id="add-error" role="alert" hidden></p>
      </div>`,
    footer: `
      <button class="btn" type="button" data-close>Cancel</button>
      <button class="btn" type="button" id="test-btn">Test address</button>
      <button class="btn btn-primary" type="button" id="add-confirm">Start capture</button>`,
    onMount: async (scope) => {
      const err = $('#add-error');
      const fail = (msg) => {
        err.textContent = msg;
        err.hidden = false;
      };
      const clearError = () => { err.hidden = true; };

      /* ---- mode ---- */
      const modeBtns = $$('[data-mode]', scope);
      modeBtns.forEach((btn) => {
        btn.onclick = () => {
          mode = btn.dataset.mode;
          modeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
          $('#mode-webcam').hidden = mode !== 'webcam';
          $('#mode-stream').hidden = mode !== 'stream';
          $('#test-btn').hidden = mode !== 'stream';
          $('#add-confirm').textContent = mode === 'stream' && tested && !tested.ok ? 'Add anyway' : 'Start capture';
          // a webcam's device name is meaningless on a network camera
          if (mode === 'stream' && $('#c-name').value === webcamAutoName) $('#c-name').value = '';
          if (mode === 'stream' && scan.status === 'idle') runScan(false);
        };
      });

      /* ---- webcam devices (unchanged behaviour) ---- */
      try {
        const devices = await api('/api/devices');
        state.devices = devices;
        const list = $('#device-list');
        if (!devices.length) {
          list.innerHTML = `<p class="quiet" style="font-size:var(--t-12);padding:var(--s2) 0">
            No capture devices found. Check that the webcam is plugged in and not in use by another app.</p>`;
          $('#device-hint').textContent = '';
        } else {
          list.innerHTML = devices.map((d, i) => `
            <button class="device-option" type="button" data-device="${esc(d.id)}" aria-selected="${i === 0}">
              ${icon('camera')}
              <span class="dev-name">${esc(d.name)}</span>
              ${d.id !== d.name ? `<span class="dev-id">${esc(d.id)}</span>` : '<span></span>'}
            </button>`).join('');
          chosen = devices[0].id;
          webcamAutoName = devices[0].name.includes('Webcam') ? 'Local webcam' : devices[0].name;
          $('#c-name').value = webcamAutoName;
          $$('.device-option', list).forEach((btn) => {
            btn.onclick = () => {
              $$('.device-option', list).forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
              chosen = btn.dataset.device;
              const dev = devices.find((d) => d.id === chosen);
              if (dev && !$('#c-name').value) $('#c-name').value = dev.name;
            };
          });
          $('#device-hint').textContent = `${devices.length} device${devices.length === 1 ? '' : 's'} available.`;
        }
      } catch (e) {
        $('#device-list').innerHTML = `<p class="quiet" style="font-size:var(--t-12)">${esc(e.message)}</p>`;
        $('#device-hint').textContent = '';
      }

      /* ---- the URL that will be stored, built exactly as the server builds it ---- */
      const enc = encodeURIComponent;
      const fields = () => ({
        preset: $('#s-preset').value,
        host: $('#s-host').value.trim(),
        port: Number($('#s-port').value) || undefined,
        user: $('#s-user').value,
        password: $('#s-pass').value,
        channel: Number($('#s-chan').value) || 1,
        quality: $('#s-quality').value,
        source: $('#s-url').value.trim(),
      });

      function derive(f) {
        if (needsUrl(f.preset)) return f.source || '';
        if (!f.host) return '';
        const auth = f.user ? `${enc(f.user)}:${enc(f.password)}@` : '';
        const port = f.port || 554;
        const sub = f.quality === '0' ? 0 : 1;
        switch (f.preset) {
          case 'hikvision':
            return `rtsp://${auth}${f.host}:${port}/Streaming/Channels/${f.channel}0${sub === 0 ? '1' : '2'}`;
          case 'xmeye':
            return `rtsp://${f.host}:${port}/user=${enc(f.user)}&password=${enc(f.password)}&channel=${f.channel}&stream=${sub}.sdp?`;
          case 'dahua':
            return `rtsp://${auth}${f.host}:${port}/cam/realmonitor?channel=${f.channel}&subtype=${sub}`;
          case 'onvif':
            return `rtsp://${auth}${f.host}:${port}/`;
          default:
            return `rtsp://${auth}${f.host}:${port}/cam/realmonitor?channel=${f.channel}&subtype=${sub}`;
        }
      }

      const maskUrl = (url) => url
        .replace(/\/\/([^:/@]+):([^@]*)@/, (m, u, p) => `//${u}:${p ? '••••' : ''}@`)
        .replace(/(password=)([^&\s]+)/i, (m, k) => `${k}••••`);

      function syncForm() {
        const f = fields();
        const urlMode = needsUrl(f.preset);
        // A full URL means every structured field is redundant — showing them
        // dimmed would still suggest they matter.
        ['#cell-host', '#cell-port', '#cell-credentials', '#cell-stream'].forEach((sel) => {
          $(sel).hidden = urlMode;
        });
        $('#cell-url').hidden = !urlMode;
        $('#cell-url').querySelector('label').textContent = f.preset === 'http' ? 'MJPEG URL' : 'Stream URL';
        // The chosen row is a claim about the form; when they disagree, the
        // row is what is wrong, so drop it back to the full list.
        if (scan.chosen && (urlMode || f.host !== scan.chosen.host)) {
          scan.chosen = null;
          paintScan();
        }
        const derived = derive(f);
        $('#s-derived').hidden = urlMode;
        $('#s-derived').textContent = derived ? maskUrl(derived) : '—';
        $('#s-derived').dataset.empty = derived ? 'false' : 'true';
        if (tested) { tested = null; paintProbe(null); }
      }

      ['#s-preset', '#s-host', '#s-port', '#s-user', '#s-pass', '#s-chan', '#s-quality', '#s-url']
        .forEach((sel) => $(sel).addEventListener('input', () => { clearError(); syncForm(); }));

      /* ---- password visibility ---- */
      $('#s-eye').onclick = () => {
        const input = $('#s-pass');
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        $('#s-eye').textContent = show ? 'Hide' : 'Show';
        $('#s-eye').setAttribute('aria-pressed', String(show));
      };

      /* ---- discovery ---- */
      function paintScan() {
        const rows = $('#scan-rows');
        const meta = $('#scan-meta');
        const btn = $('#scan-btn');
        if (scan.status === 'running') {
          btn.disabled = true;
          btn.querySelector('span').textContent = 'Scanning';
          meta.textContent = 'looking…';
          rows.innerHTML = Array.from({ length: 3 }, () => `
            <div class="scan-row is-skeleton" aria-hidden="true">
              <span class="skeleton" style="height:12px;width:88px;border-radius:var(--r1)"></span>
              <span class="skeleton" style="height:12px;width:60%"></span>
              <span></span><span></span>
            </div>`).join('');
          return;
        }
        btn.disabled = false;
        btn.querySelector('span').textContent = scan.data ? 'Rescan' : 'Scan';

        if (scan.status === 'idle') {
          meta.textContent = 'not scanned';
          rows.innerHTML = `<p class="acq-empty">Scanning tells you which cameras this machine can reach, so nothing has to be typed from memory.</p>`;
          return;
        }
        if (scan.status === 'error') {
          meta.textContent = 'failed';
          rows.innerHTML = `<p class="acq-empty" data-tone="error">${esc(scan.error)}
            <button class="btn btn-sm" type="button" id="scan-retry">Try again</button></p>`;
          $('#scan-retry').onclick = () => runScan(false);
          return;
        }

        const hosts = scan.data.hosts || [];
        const cams = hosts.filter((h) => h.camera);
        // Once a device is picked the list is noise — collapse to the one row
        // and give the form the vertical space back.
        if (scan.chosen) {
          const c = scan.chosen;
          meta.textContent = 'selected';
          rows.innerHTML = `
            <div class="scan-row is-chosen">
              <span class="scan-host mono">${esc(c.host)}</span>
              <span class="scan-kind"><b>${esc(c.kind)}</b><small>${esc(c.title || c.vendor || '—')}</small></span>
              <span class="scan-port mono">${esc(c.port)}</span>
              <button class="btn btn-sm btn-ghost" type="button" id="scan-change">Change</button>
            </div>`;
          $('#scan-change').onclick = () => { scan.chosen = null; paintScan(); };
          return;
        }
        meta.textContent = `${hosts.length} device${hosts.length === 1 ? '' : 's'} · ${cams.length} camera${cams.length === 1 ? '' : 's'} · ${Math.round((scan.data.ms || 0) / 100) / 10}s`;
        if (!hosts.length) {
          rows.innerHTML = `<p class="acq-empty">Nothing answered on ${esc(scan.data.subnet || 'this subnet')}. Enter the address by hand below.</p>`;
          return;
        }
        rows.innerHTML = hosts.map((h) => `
          <button class="scan-row" type="button"
                  data-host="${esc(h.host)}" data-port="${h.rtspPort || h.ports[0] || 554}"
                  data-preset="${esc(h.preset)}" data-kind="${esc(h.kind)}"
                  data-title="${esc(h.title || h.server || '')}" data-vendor="${esc(h.vendor || '')}">
            <span class="scan-host mono">${esc(h.host)}</span>
            <span class="scan-kind"><b>${esc(h.kind)}</b><small>${esc(h.title || h.server || h.vendor || '—')}</small></span>
            <span class="scan-port mono">${h.rtspPort ? h.rtspPort : (h.ports[0] || '')}</span>
            ${h.added
              ? '<span class="chip" data-tone="accent">in use</span>'
              : h.camera ? '<span class="chip">camera</span>' : '<span class="chip">device</span>'}
          </button>`).join('');
      }

      async function runScan(force) {
        if (scan.status === 'running') return;
        scan = { status: 'running', data: scan.data, error: null };
        paintScan();
        try {
          const data = await api(`/api/discover${force ? '?refresh=1' : ''}`);
          scan = { status: 'ready', data, error: null, chosen: scan.chosen };
        } catch (e) {
          scan = { status: 'error', data: null, error: e.message };
        }
        paintScan();
      }

      $('#scan-btn').onclick = () => runScan(true);
      $('#scan-rows').addEventListener('click', (e) => {
        const row = e.target.closest('.scan-row');
        if (!row || !row.dataset.host) return;
        $('#s-host').value = row.dataset.host;
        $('#s-port').value = row.dataset.port || '554';
        $('#s-preset').value = row.dataset.preset || 'auto';
        scan.chosen = {
          host: row.dataset.host,
          port: row.dataset.port || '554',
          kind: row.dataset.kind || '',
          title: row.dataset.title || '',
          vendor: row.dataset.vendor || '',
        };
        if (!$('#c-name').value.trim()) $('#c-name').value = row.dataset.kind || '';
        syncForm();
        paintScan();
        $('#s-user').focus();
      });

      /* ---- probe ---- */
      function paintProbe(result) {
        const chip = $('#probe-chip');
        const msg = $('#probe-msg');
        const note = $('#probe-note');
        const img = $('#probe-img');
        const empty = $('#probe-empty');
        note.hidden = true;
        img.hidden = true;
        empty.hidden = false;

        if (probing) {
          chip.textContent = 'testing';
          chip.removeAttribute('data-tone');
          msg.textContent = 'Asking the camera for one frame…';
          empty.textContent = 'REQUESTING';
          return;
        }
        if (!result) {
          chip.textContent = 'untested';
          chip.removeAttribute('data-tone');
          msg.textContent = 'Test the address before adding it. One frame is the only proof that matters.';
          empty.textContent = 'NO FRAME';
          return;
        }
        if (result.ok) {
          chip.textContent = 'open';
          chip.dataset.tone = 'accent';
          img.src = result.preview;
          img.hidden = false;
          empty.hidden = true;
          msg.innerHTML = `<span class="mono">${result.width || '?'}×${result.height || '?'} · ${result.ms} ms</span>`;
          return;
        }
        const refused = result.status === 'auth';
        chip.textContent = refused ? 'credentials refused' : 'no stream';
        chip.dataset.tone = refused ? 'live' : 'warn';
        empty.textContent = refused ? 'LOCKED' : 'NO SIGNAL';
        msg.textContent = result.message || 'No frame.';
        if (refused) {
          note.hidden = false;
          note.textContent = 'Most recorders freeze the account for 30 minutes after five wrong passwords. Check the label before trying again.';
        }
      }

      $('#test-btn').onclick = async () => {
        const f = fields();
        clearError();
        if (!f.host && !f.source) return fail('Enter an address first.');
        probing = true;
        paintProbe(null);
        const btn = $('#test-btn');
        btn.disabled = true;
        btn.textContent = 'Testing…';
        try {
          tested = await api('/api/cameras/probe', { method: 'POST', body: f });
          paintProbe(tested);
          if (tested.ok && !$('#c-name').value.trim()) {
            const label = ($('#s-preset').selectedOptions[0] || {}).textContent || 'Camera';
            $('#c-name').value = label.split('·')[0].trim();
          }
        } catch (e) {
          tested = { ok: false, status: 'error', message: e.message };
          paintProbe(tested);
        } finally {
          probing = false;
          btn.disabled = false;
          btn.textContent = 'Test address';
          paintProbe(tested);
          $('#add-confirm').textContent = tested && !tested.ok ? 'Add anyway' : 'Start capture';
        }
      };

      /* ---- commit ---- */
      $('#add-confirm').onclick = async () => {
        clearError();
        const name = $('#c-name').value.trim();
        const detectFps = Number($('#c-rate').value) || 2;
        if (!name) return fail('Give the camera a name.');

        let body;
        if (mode === 'webcam') {
          if (!chosen) return fail('Choose a device first.');
          body = { name, kind: 'webcam', source: chosen, detectFps };
        } else {
          const f = fields();
          if (needsUrl(f.preset)) {
            if (!f.source) return fail('Paste the stream URL.');
            if (!/^(rtsp|rtmp|https?):\/\//i.test(f.source)) {
              return fail('The URL must start with rtsp://, rtmp://, http:// or https://');
            }
          } else if (!f.host) {
            return fail('Enter the camera address, or pick one from the scan.');
          }
          body = { name, detectFps, ...f };
        }

        const btn = $('#add-confirm');
        btn.disabled = true;
        btn.textContent = 'Starting…';
        try {
          const cam = await api('/api/cameras', { method: 'POST', body });
          state.cameras.push({ ...cam, state: { status: 'starting', fps: 0, frameCount: 0 } });
          state.selectedId = cam.id;
          liveSig = '';
          closeModal();
          renderChrome();
          renderRoute({ full: true });
          toast(`${cam.name} added — opening the stream`);
        } catch (e) {
          fail(e.message);
          btn.disabled = false;
          btn.textContent = 'Start capture';
        }
      };

      syncForm();
      paintScan();
      paintProbe(null);
      $('#test-btn').hidden = true;
    },
  });
}

/* enroll ------------------------------------------------------------- */

async function openEnroll({ person = null, focusBox = null, faceThumb = null } = {}) {
  const isSample = !!person;
  const cams = state.cameras.filter((c) => c.enabled);
  let mode = cams.length ? 'camera' : 'upload';
  let cameraId = (state.selectedId && cams.some((c) => c.id === state.selectedId))
    ? state.selectedId
    : (cams[0] ? cams[0].id : null);
  let imageData = null;
  let previewTimer = null;

  openModal({
    title: isSample ? `Another angle for ${person.name}` : 'Enroll a person',
    body: `
      <div class="enroll-steps">
        <div class="segmented" role="group" aria-label="Source">
          <button type="button" data-mode="camera" aria-pressed="${mode === 'camera'}" ${cams.length ? '' : 'disabled'}>From camera</button>
          <button type="button" data-mode="upload" aria-pressed="${mode === 'upload'}">Upload image</button>
        </div>

        <div id="en-camera" ${mode === 'camera' ? '' : 'hidden'}>
          <div class="field">
            <label for="en-cam">Camera</label>
            <select class="select" id="en-cam">
              ${cams.map((c) => `<option value="${esc(c.id)}" ${c.id === cameraId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="enroll-preview" style="margin-top:var(--s3)">
            <img id="en-preview" alt="Live preview">
            <span class="badge" id="en-badge">${focusBox ? 'marked face' : 'live frame'}</span>
          </div>
          <p class="hint" style="margin-top:var(--s2)">Face the camera, fill about a third of the frame, avoid backlight.</p>
        </div>

        <div id="en-upload" ${mode === 'upload' ? '' : 'hidden'}>
          <div class="field">
            <label for="en-file">Photo</label>
            <input class="input" id="en-file" type="file" accept="image/*">
            <p class="hint">One clear face per image. JPEG or PNG.</p>
          </div>
          <div class="enroll-preview" style="margin-top:var(--s3)">
            <img id="en-file-preview" alt="Selected photo preview">
          </div>
        </div>

        ${isSample ? '' : `
        <div class="field">
          <label for="en-name">Name</label>
          <input class="input" id="en-name" placeholder="Who is this?" maxlength="60" autocomplete="off">
        </div>`}

        <p class="field" id="en-error" hidden style="color:var(--live);font-size:var(--t-12)"></p>
      </div>`,
    footer: `
      <button class="btn" type="button" data-close>Cancel</button>
      <button class="btn btn-primary" type="button" id="en-confirm" ${isSample ? '' : 'disabled'}>
        ${isSample ? 'Add sample' : 'Enroll'}
      </button>`,
    onMount: (scope) => {
      const modeBtns = $$('[data-mode]', scope);
      modeBtns.forEach((btn) => {
        btn.onclick = () => {
          mode = btn.dataset.mode;
          modeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
          $('#en-camera').hidden = mode !== 'camera';
          $('#en-upload').hidden = mode !== 'upload';
        };
      });

      const paintPreview = () => {
        const img = $('#en-preview');
        if (!img || !cameraId) return;
        img.src = `/api/cameras/${cameraId}/frame.jpg?t=${Date.now()}`;
      };
      paintPreview();
      clearInterval(previewTimer);
      previewTimer = setInterval(paintPreview, 1200);

      $('#en-cam')?.addEventListener('change', (e) => {
        cameraId = e.target.value;
        paintPreview();
      });

      const nameInput = $('#en-name');
      const confirmBtn = $('#en-confirm');
      if (nameInput) {
        nameInput.oninput = () => { confirmBtn.disabled = !nameInput.value.trim(); };
        setTimeout(() => nameInput.focus(), 40);
      }

      $('#en-file')?.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          imageData = String(reader.result);
          $('#en-file-preview').src = imageData;
        };
        reader.readAsDataURL(file);
      });

      confirmBtn.onclick = async () => {
        const err = $('#en-error');
        err.hidden = true;
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Working…';
        try {
          const body = isSample
            ? (mode === 'upload' ? { image: imageData } : { cameraId, box: focusBox })
            : (mode === 'upload'
              ? { name: nameInput.value.trim(), image: imageData }
              : { name: nameInput.value.trim(), cameraId, box: focusBox });

          if (mode === 'upload' && !imageData) throw new Error('Choose a photo first.');
          if (!isSample && !body.name) throw new Error('Enter a name.');

          const res = await api(isSample ? `/api/people/${person.id}/samples` : '/api/people', { method: 'POST', body });
          clearInterval(previewTimer);
          closeModal();
          await refreshState();
          toast(isSample ? `Sample added — ${res.samples} total` : `${res.name} enrolled`);
        } catch (e) {
          err.textContent = e.message;
          err.hidden = false;
          confirmBtn.disabled = false;
          confirmBtn.textContent = isSample ? 'Add sample' : 'Enroll';
        }
      };
    },
  });
}

/* ================================================================== */
/* boot                                                                */
/* ================================================================== */

function tickClocks() {
  $('#wall-clock').textContent = clock(new Date());
  if (state.route === 'live') updateLiveDynamic();
}

let booted = false;
function bootOnce() {
  if (booted) return;
  booted = true;
  boot();
}

async function boot() {
  state.route = routeFromHash();
  $('#add-camera-btn').addEventListener('click', () => openAddCamera());

  try {
    const data = await api('/api/state');
    hydrate(data);
  } catch (err) {
    toast(`Cannot reach the server: ${err.message}`, 'error');
  }

  connectLive();
  setInterval(tickClocks, 1000);
  setInterval(pollCameras, 3000);
  tickClocks();

  // keep the event strip current even before the first SSE event arrives
  try {
    state.events = await api('/api/events?limit=8');
    if (state.route === 'live') renderRecent();
  } catch { /* non-critical */ }
}

document.addEventListener('DOMContentLoaded', bootOnce);
if (document.readyState !== 'loading') bootOnce();
