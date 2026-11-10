'use strict';
const { z } = require('zod');
const sharp = require('sharp');
const fs = require('node:fs');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');

const db = require('./db');
const vision = require('./detect/vision');
const understand = require('./detect/understand');
const { annotate } = require('./render');
const { listDevices } = require('./capture/camera');

const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
const image = (buf, extra) => ({
  content: [
    { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' },
    { type: 'text', text: JSON.stringify(extra, null, 2) },
  ],
});

function decodeB64(input) {
  const raw = String(input).replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(raw, 'base64');
}

function createMcpServer(pipeline) {
  const server = new McpServer(
    { name: 'isee', version: '0.1.0' },
    {
      instructions:
        'isee watches local cameras. Use list_cameras to see the fleet, then capture_frame with annotate=true ' +
        'to see a frame exactly as the models scored it. identify_objects and recognize_faces return structured ' +
        'detections. Enrol people with enroll_person so recognize_faces resolves names instead of "unknown".',
    },
  );

  const cameraArgs = {
    camera_id: z.string().optional().describe('Camera id or name. Defaults to the first enabled camera.'),
  };

  function pickCamera(idOrName) {
    const cams = db.listCameras();
    if (!cams.length) throw new Error('no cameras are configured; call add_camera first');
    if (!idOrName) return cams.find((c) => c.enabled) || cams[0];
    const hit = cams.find((c) => c.id === idOrName)
      || cams.find((c) => c.name.toLowerCase() === String(idOrName).toLowerCase());
    if (!hit) throw new Error(`unknown camera "${idOrName}"`);
    return hit;
  }

  async function analysable(cameraId, opts = {}) {
    const cam = pickCamera(cameraId);
    const frame = pipeline.frame(cam.id);
    if (!frame) throw new Error(`camera "${cam.name}" has no frame yet (status: ${pipeline.camera(cam.id)?.state.status || 'unknown'})`);
    const data = await pipeline.analyseNow(cam.id, opts);
    return { cam, frame: frame.buffer, data };
  }

  /* ---------------- system ---------------- */

  server.registerTool(
    'isee_status',
    {
      title: 'System status',
      description: 'Models loaded, camera fleet health, gallery size and detection settings.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ok({
      models: vision.modelStatus(),
      understanding: await understand.status(),
      cameras: pipeline.cameras().map((c) => ({
        id: c.id, name: c.name, kind: c.kind, status: c.state.status,
        fps: c.state.fps, enabled: c.enabled, message: c.state.message || undefined,
      })),
      people: db.listPersons().length,
      faceSamples: db.faceGallery().length,
      settings: db.getSettings(),
      mcp: { transport: 'streamable-http', endpoint: '/mcp' },
    }),
  );

  server.registerTool(
    'list_devices',
    {
      title: 'List local capture devices',
      description: 'Enumerate USB webcams attached to this computer, for use with add_camera.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try { return ok(await listDevices()); } catch (e) { return fail(e.message); }
    },
  );

  /* ---------------- cameras ---------------- */

  server.registerTool(
    'list_cameras',
    {
      title: 'List cameras',
      description: 'Every configured camera with live status, frame rate and its most recent detections.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ok(pipeline.cameras().map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      source: c.source,
      enabled: c.enabled,
      status: c.state.status,
      fps: c.state.fps,
      hasFrame: c.state.hasFrame,
      lastDetection: c.analysis ? {
        at: new Date(c.analysis.ts).toISOString(),
        objects: c.analysis.objects.map((o) => o.label),
        faces: c.analysis.faces.map((f) => f.name || 'unknown'),
      } : null,
      message: c.state.message || undefined,
    }))),
  );

  server.registerTool(
    'add_camera',
    {
      title: 'Add a camera',
      description:
        'Register a camera and start capturing. kind=webcam takes the exact device name from list_devices ' +
        '(e.g. "Logitech Webcam C925e"). kind=rtsp takes an rtsp:// URL, kind=http an MJPEG/HLS URL.',
      inputSchema: {
        name: z.string().min(1).describe('Human label, e.g. "Front door"'),
        kind: z.enum(['webcam', 'rtsp', 'http', 'rtmp', 'file']).default('webcam'),
        source: z.string().min(1).describe('Device name for webcam, otherwise the stream URL'),
        size: z.string().optional().describe('Webcam capture size such as 1280x720'),
        detect_fps: z.number().min(0.2).max(15).optional().describe('Detection rate, frames per second (default 2)'),
      },
    },
    async (args) => {
      try {
        const cam = db.addCamera({
          name: args.name,
          kind: args.kind,
          source: args.source,
          size: args.size || null,
          detectFps: args.detect_fps ?? 2,
        });
        pipeline.ensure(db.getCamera(cam.id));
        return ok({ added: cam, note: 'capture starting; poll list_cameras for status' });
      } catch (e) { return fail(e.message); }
    },
  );

  server.registerTool(
    'update_camera',
    {
      title: 'Update a camera',
      description: 'Rename a camera, enable/disable capture, or change the detection rate.',
      inputSchema: {
        camera_id: z.string(),
        name: z.string().optional(),
        enabled: z.boolean().optional(),
        detect_fps: z.number().min(0.2).max(15).optional(),
      },
    },
    async (args) => {
      try {
        const cam = pickCamera(args.camera_id);
        const patch = {};
        if (args.name !== undefined) patch.name = args.name;
        if (args.enabled !== undefined) patch.enabled = args.enabled;
        if (args.detect_fps !== undefined) patch.detectFps = args.detect_fps;
        const updated = db.updateCamera(cam.id, patch);
        pipeline.ensure(updated);
        return ok(updated);
      } catch (e) { return fail(e.message); }
    },
  );

  server.registerTool(
    'remove_camera',
    {
      title: 'Remove a camera',
      description: 'Stop capture and delete a camera from the fleet.',
      inputSchema: { camera_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      try {
        const cam = pickCamera(args.camera_id);
        pipeline.remove(cam.id);
        db.removeCamera(cam.id);
        return ok({ removed: cam.id, name: cam.name });
      } catch (e) { return fail(e.message); }
    },
  );

  /* ---------------- vision ---------------- */

  server.registerTool(
    'capture_frame',
    {
      title: 'Capture the current frame',
      description:
        'Return the live frame as a JPEG image. With annotate=true the detections are burned in, so the image ' +
        'is proof of what the models saw.',
      inputSchema: {
        ...cameraArgs,
        annotate: z.boolean().default(true).describe('Draw boxes and labels onto the returned image'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const { frame, data } = await analysable(args.camera_id);
        const out = args.annotate ? await annotate(frame, data) : frame;
        return image(out, {
          camera: data.cameraName,
          at: new Date(data.ts).toISOString(),
          size: `${data.width}x${data.height}`,
          objects: data.objects.map((o) => ({ label: o.label, confidence: +o.score.toFixed(3) })),
          faces: data.faces.map((f) => ({
            name: f.name || 'unknown',
            similarity: f.similarity,
            confidence: +f.score.toFixed(3),
          })),
        });
      } catch (e) { return fail(e.message); }
    },
  );

  server.registerTool(
    'identify_objects',
    {
      title: 'Identify objects',
      description:
        'Run object detection on the current frame and return labels, confidences and normalised boxes. ' +
        '80 COCO classes (person, car, dog, laptop, ...). "person" is covered in more detail by recognize_faces.',
      inputSchema: {
        ...cameraArgs,
        min_confidence: z.number().min(0.05).max(0.99).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const { data } = await analysable(args.camera_id, { objectConfidence: args.min_confidence });
        return ok({
          camera: data.cameraName,
          at: new Date(data.ts).toISOString(),
          count: data.objects.length,
          objects: data.objects.map((o) => ({
            label: o.label,
            confidence: +o.score.toFixed(4),
            box: o.box,
          })),
        });
      } catch (e) { return fail(e.message); }
    },
  );

  server.registerTool(
    'recognize_faces',
    {
      title: 'Recognize faces',
      description:
        'Detect every face in the current frame and match it against enrolled people. Returns name, cosine ' +
        'similarity to the closest match, and the box. Similarity below the threshold is reported as unknown.',
      inputSchema: {
        ...cameraArgs,
        threshold: z.number().min(0.2).max(0.9).optional().describe('Minimum cosine similarity to accept a match'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const { data } = await analysable(args.camera_id, { matchThreshold: args.threshold });
        return ok({
          camera: data.cameraName,
          at: new Date(data.ts).toISOString(),
          count: data.faces.length,
          known: data.faces.filter((f) => f.personId).length,
          faces: data.faces.map((f) => ({
            name: f.name || 'unknown',
            personId: f.personId,
            similarity: f.similarity,
            box: f.box,
          })),
        });
      } catch (e) { return fail(e.message); }
    },
  );

  server.registerTool(
    'identify_region',
    {
      title: 'Identify a marked region',
      description:
        'Identify what is inside a box the operator marked on the current frame. box is normalised ' +
        '[x, y, w, h] with 0-1 values. Returns objects, recognised faces, and a cropped image of the region. ' +
        'Useful for "what is this thing?" questions about a specific part of the scene.',
      inputSchema: {
        ...cameraArgs,
        box: z.array(z.number()).length(4).describe('[x, y, w, h] normalised 0-1'),
        annotate: z.boolean().default(true).describe('Draw the matches onto the returned crop'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const cam = pickCamera(args.camera_id);
        const found = await pipeline.inspectRegion(cam.id, args.box);
        const region = found.region;
        const rel = (b) => [
          (b[0] - region[0]) / region[2],
          (b[1] - region[1]) / region[3],
          b[2] / region[2],
          b[3] / region[3],
        ];

        let imageBuffer = await fs.promises.readFile(db.shotPath(path.basename(found.crop)));
        if (args.annotate && (found.objects.length || found.faces.length)) {
          const meta = await sharp(imageBuffer).metadata();
          imageBuffer = await annotate(imageBuffer, {
            width: meta.width,
            height: meta.height,
            objects: found.objects.map((o) => ({ label: o.label, score: o.score, box: rel(o.box) })),
            faces: found.faces.map((f) => ({
              name: f.name,
              personId: f.personId,
              similarity: f.similarity,
              box: rel(f.box),
            })),
          });
        }

        return image(imageBuffer, {
          camera: found.cameraName,
          at: new Date(found.at).toISOString(),
          region: found.region,
          answer: found.guess,
          text: found.text ? { value: found.text, confidence: found.textConfidence } : null,
          objects: found.objects.map((o) => ({
            label: o.label,
            confidence: +o.score.toFixed(3),
            detectorLabel: o.detectorLabel,
            box: o.box,
          })),
          faces: found.faces.map((f) => ({
            name: f.name || 'unknown',
            personId: f.personId,
            similarity: f.similarity,
            box: f.box,
          })),
          vocabulary: (found.vocabulary || []).slice(0, 3).map((v) => ({ label: v.label, score: v.score })),
        });
      } catch (e) { return fail(e.message); }
    },
  );

  server.registerTool(
    'read_text',
    {
      title: 'Read text',
      description:
        'OCR the current frame, or only a marked region. Use this when the operator points at a label, ' +
        'sign or screen — text is not an object class, so nothing else in isee will read it.',
      inputSchema: {
        ...cameraArgs,
        box: z.array(z.number()).length(4).optional().describe('[x, y, w, h] normalised 0-1; omit for the whole frame'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const cam = pickCamera(args.camera_id);
        if (args.box) {
          const found = await pipeline.inspectRegion(cam.id, args.box);
          if (!found.text) return ok({ camera: found.cameraName, text: null, note: 'no readable text in that region' });
          return ok({
            camera: found.cameraName,
            text: found.text,
            confidence: found.textConfidence,
            crop: found.crop,
          });
        }
        const frame = pipeline.frame(cam.id);
        if (!frame) throw new Error(`camera "${cam.name}" has no frame yet`);
        const words = await understand.readText(frame.buffer);
        if (!words) return ok({ camera: cam.name, text: null, note: 'no readable text in this frame' });
        return ok({ camera: cam.name, text: words.text, confidence: words.confidence });
      } catch (e) { return fail(e.message); }
    },
  );

  /* ---------------- people ---------------- */

  server.registerTool(
    'enroll_person',
    {
      title: 'Enroll a person',
      description:
        'Create a person from a face. Either grab the most prominent face from a live camera (camera_id) or ' +
        'supply an image (image_base64). Repeat with add_face_sample to add more angles for better accuracy.',
      inputSchema: {
        name: z.string().min(1),
        note: z.string().optional(),
        camera_id: z.string().optional(),
        image_base64: z.string().optional().describe('Base64 JPEG/PNG containing exactly one clear face'),
        box: z.array(z.number()).length(4).optional().describe('Normalised [x,y,w,h] when several faces are in frame'),
      },
    },
    async (args) => {
      try {
        let source;
        let buffer;
        if (args.image_base64) {
          buffer = decodeB64(args.image_base64);
          source = 'upload';
        } else {
          const cam = pickCamera(args.camera_id);
          const f = pipeline.frame(cam.id);
          if (!f) throw new Error(`camera "${cam.name}" has no frame yet`);
          buffer = f.buffer;
          source = `camera:${cam.name}`;
        }
        const scan = await pipeline.facesInImage(buffer);
        if (!scan.faces.length) throw new Error('no face found — face the camera directly in even light and retry');
        const best = pipeline.pickFaceNear(scan, args.box);
        if (!best) throw new Error('no face found inside the marked area');

        const person = db.createPerson({ name: args.name, note: args.note || '' });
        const thumbName = await pipeline.saveFaceThumb(scan.raw, best.box, `face-${person.id}`);
        db.addFace({ personId: person.id, embedding: best.vector, thumb: thumbName, quality: best.quality });

        return ok({
          person,
          sample: { source, quality: best.quality, detectionConfidence: best.score },
          gallerySize: db.faceGallery().length,
        });
      } catch (e) { return fail(e.message); }
    },
  );

  server.registerTool(
    'add_face_sample',
    {
      title: 'Add a face sample',
      description: 'Add another enrolled sample (another angle, glasses on/off) to an existing person.',
      inputSchema: {
        person_id: z.string(),
        camera_id: z.string().optional(),
        image_base64: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const person = db.getPerson(args.person_id);
        if (!person) throw new Error('person not found');
        let buffer;
        if (args.image_base64) buffer = decodeB64(args.image_base64);
        else {
          const cam = pickCamera(args.camera_id);
          const f = pipeline.frame(cam.id);
          if (!f) throw new Error(`camera "${cam.name}" has no frame yet`);
          buffer = f.buffer;
        }
        const scan = await pipeline.facesInImage(buffer);
        if (!scan.faces.length) throw new Error('no face found in the frame');
        const best = scan.faces[0];
        const thumbName = await pipeline.saveFaceThumb(scan.raw, best.box, `face-${person.id}`);
        db.addFace({ personId: person.id, embedding: best.vector, thumb: thumbName, quality: best.quality });
        const faces = db.listFaces(person.id);
        return ok({ person: person.name, samples: faces.length, latestQuality: best.quality });
      } catch (e) { return fail(e.message); }
    },
  );

  server.registerTool(
    'list_people',
    {
      title: 'List enrolled people',
      description: 'Everyone in the face gallery, with sample counts.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ok(db.listPersons()),
  );

  server.registerTool(
    'delete_person',
    {
      title: 'Delete a person',
      description: 'Remove a person and all of their enrolled face samples.',
      inputSchema: { person_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      try {
        const p = db.getPerson(args.person_id);
        if (!p) throw new Error('person not found');
        db.removePerson(p.id);
        return ok({ removed: p.id, name: p.name });
      } catch (e) { return fail(e.message); }
    },
  );

  /* ---------------- events ---------------- */

  server.registerTool(
    'query_events',
    {
      title: 'Query the event log',
      description:
        'Search what the cameras recorded: detected objects and face recognitions, newest first. ' +
        'Use since_minutes to look back in time.',
      inputSchema: {
        camera_id: z.string().optional(),
        kind: z.enum(['object', 'face']).optional(),
        label: z.string().optional().describe('Substring match on the label, e.g. "dog" or a person name'),
        since_minutes: z.number().min(1).max(43200).optional(),
        limit: z.number().min(1).max(200).default(25),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        let cameraId = null;
        if (args.camera_id) cameraId = pickCamera(args.camera_id).id;
        const events = db.queryEvents({
          cameraId,
          kind: args.kind,
          label: args.label,
          since: args.since_minutes ? Date.now() - args.since_minutes * 60000 : null,
          limit: args.limit,
        });
        return ok(events.map((e) => ({
          id: e.id,
          at: new Date(e.ts).toISOString(),
          camera: e.cameraName,
          kind: e.kind,
          label: e.label,
          confidence: e.score,
          personId: e.personId,
          snapshot: e.snapshot ? `/shots/${e.snapshot}` : null,
        })));
      } catch (e) { return fail(e.message); }
    },
  );

  server.registerTool(
    'update_settings',
    {
      title: 'Update detection settings',
      description:
        'Tune sensitivity. Higher match_threshold means stricter face matching; lower object_confidence means ' +
        'more (and noisier) object detections.',
      inputSchema: {
        object_confidence: z.number().min(0.05).max(0.99).optional(),
        face_confidence: z.number().min(0.05).max(0.99).optional(),
        match_threshold: z.number().min(0.2).max(0.9).optional(),
        event_cooldown_ms: z.number().min(0).max(3600000).optional(),
      },
    },
    async (args) => {
      const patch = {};
      if (args.object_confidence !== undefined) patch.objectConfidence = args.object_confidence;
      if (args.face_confidence !== undefined) patch.faceConfidence = args.face_confidence;
      if (args.match_threshold !== undefined) patch.matchThreshold = args.match_threshold;
      if (args.event_cooldown_ms !== undefined) patch.eventCooldownMs = args.event_cooldown_ms;
      return ok(db.setSettings(patch));
    },
  );

  return server;
}

module.exports = { createMcpServer };
