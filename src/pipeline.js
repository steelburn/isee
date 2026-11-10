'use strict';
const { EventEmitter } = require('node:events');
const sharp = require('sharp');
const path = require('node:path');
const crypto = require('node:crypto');

const db = require('./db');
const vision = require('./detect/vision');
const understand = require('./detect/understand');
const { normaliseVocabulary, buildPrompt, displayLabel } = require('./vocab');
const { CameraSource } = require('./capture/camera');

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

/** Share of detection `a` that falls inside region `b` (both normalised). */
function overlapRatio(a, b) {
  const ax2 = a[0] + a[2];
  const ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2];
  const by2 = b[1] + b[3];
  const iw = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  return (iw * ih) / (a[2] * a[3] + 1e-9);
}

function pixelRegion(region, W, H) {
  const left = Math.min(W - 8, Math.max(0, Math.round(region[0] * W)));
  const top = Math.min(H - 8, Math.max(0, Math.round(region[1] * H)));
  const width = Math.max(16, Math.min(W - left, Math.round(region[2] * W)));
  const height = Math.max(16, Math.min(H - top, Math.round(region[3] * H)));
  return { left, top, width, height };
}

class Pipeline extends EventEmitter {
  constructor() {
    super();
    this.sources = new Map();
    this.analysis = new Map();     // cameraId -> last analysis payload
    this.cooldowns = new Map();    // "cam:kind:key" -> ts
    this.running = new Set();      // cameraIds with an in-flight analysis
    this.lastTick = new Map();
    this.pending = 0;
    this.maxConcurrent = 2;
    this.refineCache = new Map();
    setInterval(() => this.pruneCooldowns(), 60000).unref();
  }

  /* ---------------- lifecycle ---------------- */

  start() {
    this.seedCooldowns();
    for (const cam of db.listCameras()) this.ensure(cam);
  }

  /** A restart must not re-log what the previous run already recorded. */
  seedCooldowns() {
    const cooldown = db.getSettings().eventCooldownMs ?? 60000;
    if (!cooldown) return;
    for (const ev of db.queryEvents({ since: Date.now() - cooldown, limit: 400 })) {
      const key = ev.kind === 'face'
        ? (ev.personId ? `face:${ev.personId}` : 'face:unknown')
        : `object:${ev.label}`;
      const k = `${ev.cameraId}:${key}`;
      this.cooldowns.set(k, Math.max(this.cooldowns.get(k) || 0, ev.ts));
    }
  }

  ensure(cam) {
    let src = this.sources.get(cam.id);
    if (!src) {
      src = new CameraSource(cam);
      src.on('frame', (buf) => this.onFrame(cam.id, buf));
      src.on('status', (snap) => {
        this.emit('camera', snap);
        if (snap.status !== 'live') this.analysis.delete(cam.id);
      });
      this.sources.set(cam.id, src);
    } else {
      src.setConfig(cam);
    }
    if (cam.enabled && !src.proc && !src.wantRunning) src.start();
    if (!cam.enabled && src.wantRunning) src.stop();
    return src;
  }

  remove(camId) {
    const src = this.sources.get(camId);
    if (src) { src.stop(); this.sources.delete(camId); }
    this.analysis.delete(camId);
    this.emit('camera', { id: camId, status: 'removed' });
  }

  stopAll() {
    for (const src of this.sources.values()) src.stop();
  }

  source(camId) { return this.sources.get(camId) || null; }

  /* ---------------- frames ---------------- */

  onFrame(camId, buffer) {
    const src = this.sources.get(camId);
    const cam = src ? src.config : null;
    if (!cam || !cam.enabled) return;
    const interval = 1000 / Math.max(0.2, cam.detectFps || 2);
    const last = this.lastTick.get(camId) || 0;
    const now = Date.now();
    if (now - last < interval) return;
    if (this.running.has(camId) || this.running.size >= this.maxConcurrent) return;
    if (!vision.modelsReady()) return;
    this.lastTick.set(camId, now);
    this.analyseBuffer(cam, buffer, true).catch((err) => {
      this.emit('detect:error', { cameraId: camId, message: err.message });
    });
  }

  /**
   * The detector can only say one of 80 COCO words. When it is not sure, ask
   * CLIP what the crop actually looks like against the operator's vocabulary.
   * One crop per tick, cached by label + coarse box, so a still scene settles.
   */
  async enrichObjects(buffer, objects, settings, budget = 1, faces = []) {
    if (settings.refineObjects === false) return objects;
    if (!understand.clip.ready()) { understand.warm(); return objects; }
    const vocabulary = normaliseVocabulary(settings.vocabulary);
    let left = budget;

    for (const o of objects) {
      if (o.score >= 0.65 || o.refined || o.fromCrop) continue;
      // never second-guess a person box, and never relabel a crop a face lives in:
      // CLIP on a face crop answers "a pair of glasses", and identity is the face
      // pipeline's job, not the vocabulary's.
      if (o.label === 'person') continue;
      if (faces.some((f) => overlapRatio(o.box, f.box) > 0.25)) continue;
      const key = `${o.label}|${Math.round(o.box[0] * 16)}|${Math.round(o.box[1] * 16)}|${Math.round(o.box[2] * 8)}|${Math.round(o.box[3] * 8)}`;
      const cached = this.refineCache.get(key);
      if (cached && Date.now() - cached.at < 8000) { Object.assign(o, cached.patch); continue; }
      if (left <= 0) continue;
      left--;

      const meta = await sharp(buffer).metadata();
      const p = pixelRegion(o.box, meta.width, meta.height);
      let crop;
      try {
        crop = await sharp(buffer).extract(p).jpeg({ quality: 90 }).toBuffer();
      } catch { continue; }

      const own = buildPrompt(o.label);
      let ranked;
      try {
        ranked = await understand.describe(crop, vocabulary, [own]);
      } catch { continue; }
      const top = ranked[0];
      const mine = ranked.find((r) => r.prompt === own);
      const patch = { alternatives: ranked.slice(0, 3).map((r) => ({ label: r.label, score: r.score })) };

      if (top && mine && top.prompt !== own && top.score >= 0.25 && top.score - mine.score >= 0.12) {
        patch.detectorLabel = o.label;
        patch.detectorScore = o.score;
        patch.label = top.label;
        patch.score = top.score;
        patch.refined = true;
        patch.ambiguous = !!(ranked[1] && top.score - ranked[1].score < 0.08);
      }

      this.refineCache.set(key, { patch, at: Date.now() });
      if (this.refineCache.size > 400) {
        const first = this.refineCache.keys().next().value;
        this.refineCache.delete(first);
      }
      Object.assign(o, patch);
    }
    return objects;
  }

  async analyseBuffer(cam, buffer, live = false) {
    this.running.add(cam.id);
    try {
      const settings = db.getSettings();
      const { result } = await vision.analyse(buffer, {
        gallery: db.faceGallery(),
        objectConfidence: settings.objectConfidence,
        faceConfidence: settings.faceConfidence,
        matchThreshold: settings.matchThreshold,
      });

      await this.enrichObjects(buffer, result.objects, settings, 1, result.faces.map((f) => ({
        box: [f.box[0] / result.width, f.box[1] / result.height, f.box[2] / result.width, f.box[3] / result.height],
      })));

      const w = result.width;
      const h = result.height;
      const payload = {
        cameraId: cam.id,
        width: w,
        height: h,
        ts: Date.now(),
        objects: result.objects,
        faces: result.faces.map((f) => ({
          box: [f.box[0] / w, f.box[1] / h, f.box[2] / w, f.box[3] / h],
          personId: f.personId,
          name: f.name,
          similarity: f.similarity,
          score: f.score,
        })),
      };
      this.analysis.set(cam.id, payload);
      this.emit('detection', payload);

      if (live) await this.logEvents(cam, payload, buffer, settings);
      return { payload, raw: null };
    } finally {
      this.running.delete(cam.id);
    }
  }

  async logEvents(cam, payload, buffer, settings) {
    const now = Date.now();
    const cooldown = settings.eventCooldownMs ?? 60000;
    const due = [];

    const seen = new Set();
    for (const o of payload.objects) {
      if (o.label === 'person') continue; // people are covered by the face pipeline
      const key = `object:${o.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (this.isCool(cam.id, key, cooldown, now)) due.push({ kind: 'object', label: o.label, score: o.score, personId: null, box: o.box });
    }

    const faces = payload.faces;
    for (const f of faces) {
      const key = f.personId ? `face:${f.personId}` : 'face:unknown';
      if (this.isCool(cam.id, key, cooldown, now)) {
        due.push({
          kind: 'face',
          label: f.name || 'Unknown face',
          score: f.similarity,
          personId: f.personId,
          box: f.box,
        });
      }
    }
    if (faces.some((f) => !f.personId) && this.isCool(cam.id, 'unknown-presence', cooldown, now)) {
      // nothing extra: the unknown-face row already carries it
    }

    if (!due.length) return;

    let snapshot = null;
    try {
      const thumb = await sharp(buffer).resize(480, null, { withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
      const name = `${now}-${crypto.randomBytes(4).toString('hex')}.jpg`;
      await sharp(thumb).toFile(db.shotPath(name));
      snapshot = name;
    } catch { /* a missing thumbnail must not lose the event */ }

    for (const d of due) {
      const evId = db.addEvent({
        cameraId: cam.id,
        kind: d.kind,
        label: d.label,
        score: d.score,
        personId: d.personId,
        snapshot,
        box: d.box,
        ts: now,
      });
      this.emit('event', {
        id: evId,
        cameraId: cam.id,
        cameraName: cam.name,
        kind: d.kind,
        label: d.label,
        score: d.score,
        personId: d.personId,
        snapshot: db.shotUrl(snapshot),
        box: d.box,
        ts: now,
      });
    }
  }

  isCool(camId, key, cooldown, now) {
    const k = `${camId}:${key}`;
    const last = this.cooldowns.get(k) || 0;
    if (now - last < cooldown) return false;
    this.cooldowns.set(k, now);
    return true;
  }

  pruneCooldowns() {
    const cutoff = Date.now() - 3600000;
    for (const [k, ts] of this.cooldowns) if (ts < cutoff) this.cooldowns.delete(k);
  }

  /* ---------------- queries used by HTTP + MCP ---------------- */

  cameras() {
    return db.listCameras().map((cam) => {
      const src = this.sources.get(cam.id);
      const live = src ? src.snapshot() : {
        id: cam.id, name: cam.name, kind: cam.kind, source: cam.source,
        enabled: cam.enabled, status: cam.enabled ? 'starting' : 'stopped',
        message: '', fps: 0, frameCount: 0, latestAt: 0, hasFrame: false,
      };
      const analysis = this.analysis.get(cam.id) || null;
      return { ...cam, state: live, analysis };
    });
  }

  camera(camId) {
    return this.cameras().find((c) => c.id === camId) || null;
  }

  frame(camId) {
    const src = this.sources.get(camId);
    if (!src || !src.latest) return null;
    return { buffer: src.latest, at: src.latestAt };
  }

  async snapshot(camId) {
    const f = this.frame(camId);
    if (!f) {
      const cam = db.getCamera(camId);
      throw new Error(cam ? `camera "${cam.name}" has no frame yet` : 'camera not found');
    }
    return f.buffer;
  }

  /** Fresh analysis of the current frame, bypassing the throttle. */
  async analyseNow(camId, opts = {}) {
    const cam = db.getCamera(camId);
    if (!cam) throw new Error('camera not found');
    const f = this.frame(camId);
    if (!f) throw new Error(`camera "${cam.name}" has no frame yet`);
    const settings = db.getSettings();
    const { result } = await vision.analyse(f.buffer, {
      gallery: db.faceGallery(),
      objectConfidence: opts.objectConfidence ?? settings.objectConfidence,
      faceConfidence: opts.faceConfidence ?? settings.faceConfidence,
      matchThreshold: opts.matchThreshold ?? settings.matchThreshold,
    });
    await this.enrichObjects(f.buffer, result.objects, settings, 3, result.faces.map((x) => ({
      box: [x.box[0] / result.width, x.box[1] / result.height, x.box[2] / result.width, x.box[3] / result.height],
    })));
    const w = result.width;
    const h = result.height;
    return {
      cameraId: cam.id,
      cameraName: cam.name,
      width: w,
      height: h,
      ts: Date.now(),
      objects: result.objects,
      faces: result.faces.map((x) => ({
        box: [x.box[0] / w, x.box[1] / h, x.box[2] / w, x.box[3] / h],
        personId: x.personId,
        name: x.name,
        similarity: x.similarity,
        score: x.score,
        boxPx: x.box,
      })),
    };
  }

  /** Identify whatever a person marked on the frame. */
  async inspectRegion(camId, regionBox) {
    const cam = db.getCamera(camId);
    if (!cam) throw new Error('camera not found');
    const frame = this.frame(camId);
    if (!frame) throw new Error(`camera "${cam.name}" has no frame yet`);
    if (!vision.modelsReady()) throw new Error('models are still loading');

    const settings = db.getSettings();
    const raw = await vision.decodeRaw(frame.buffer);
    const W = raw.width;
    const H = raw.height;

    const region = [
      clamp01(regionBox[0]),
      clamp01(regionBox[1]),
      Math.min(0.99, Math.max(0.02, Number(regionBox[2]) || 0.2)),
      Math.min(0.99, Math.max(0.02, Number(regionBox[3]) || 0.2)),
    ];
    region[2] = Math.min(region[2], 1 - region[0]);
    region[3] = Math.min(region[3], 1 - region[1]);

    const { result } = await vision.analyse(frame.buffer, {
      gallery: db.faceGallery(),
      objectConfidence: Math.max(0.2, settings.objectConfidence - 0.1),
      faceConfidence: settings.faceConfidence,
      matchThreshold: settings.matchThreshold,
    });

    let objects = result.objects
      .filter((o) => overlapRatio(o.box, region) >= 0.3)
      .map((o) => ({ ...o, fromCrop: false }));

    // a small thing the whole-frame pass missed: look at the marked patch alone
    if (!objects.length) {
      const p = pixelRegion(region, W, H);
      const crop = await sharp(frame.buffer)
        .extract(p)
        .resize(640, 640, { fit: 'fill' })
        .jpeg({ quality: 90 })
        .toBuffer();
      const cropRaw = await vision.decodeRaw(crop);
      const dets = await vision.runObjects(cropRaw, Math.max(0.15, settings.objectConfidence * 0.5));
      objects = dets.map((d) => ({
        ...d,
        box: [
          (p.left + d.box[0] * p.width) / W,
          (p.top + d.box[1] * p.height) / H,
          (d.box[2] * p.width) / W,
          (d.box[3] * p.height) / H,
        ],
        fromCrop: true,
      }));
    }

    const faces = [];
    for (const f of result.faces) {
      const nb = [f.box[0] / W, f.box[1] / H, f.box[2] / W, f.box[3] / H];
      if (overlapRatio(nb, region) < 0.25) continue;
      faces.push({
        name: f.name,
        personId: f.personId,
        similarity: f.similarity,
        score: f.score,
        box: nb,
        thumb: await this.saveFaceThumb(raw, f.box, 'mark'),
      });
    }

    const p = pixelRegion(region, W, H);
    const cropName = `mark-${crypto.randomBytes(4).toString('hex')}-${Date.now()}.jpg`;
    await sharp(frame.buffer).extract(p).jpeg({ quality: 90 }).toFile(db.shotPath(cropName));
    const cropBuffer = await sharp(frame.buffer).extract(p).jpeg({ quality: 90 }).toBuffer();

    const vocabulary = normaliseVocabulary(settings.vocabulary);
    const understanding = understand.ready();
    if (!understanding.clip) understand.warm();

    await this.enrichObjects(frame.buffer, objects, settings, 3, faces.map((f) => ({ box: f.box })));

    let text = null;
    let words = null;
    if (understanding.ocr) {
      words = await understand.readText(cropBuffer);
      if (words) text = words.text;
    }

    let vocabularyMatch = null;
    if (understanding.clip) {
      try {
        const ranked = await understand.describe(cropBuffer, vocabulary);
        vocabularyMatch = ranked.slice(0, 4);
      } catch { /* vocabulary is an optional extra */ }
    }

    const guess = this.resolveGuess({ faces, objects, text, words, vocabularyMatch });

    return {
      cameraId: cam.id,
      cameraName: cam.name,
      at: Date.now(),
      region,
      crop: db.shotUrl(cropName),
      objects: objects.slice(0, 8),
      faces: faces.slice(0, 6),
      text,
      textConfidence: words ? words.confidence : null,
      vocabulary: vocabularyMatch,
      guess,
      understanding: { clip: understanding.clip, ocr: understanding.ocr },
    };
  }

  /** One answer for the operator, plus how it was reached. */
  resolveGuess({ faces, objects, text, words, vocabularyMatch }) {
    const face = faces[0];
    if (face) {
      return {
        kind: face.personId ? 'face' : 'unknown-face',
        label: face.personId ? face.name : 'Unknown face',
        confidence: face.personId ? face.similarity : face.score,
        personId: face.personId || null,
        detail: face.personId
          ? `matched at ${(face.similarity || 0).toFixed(2)}`
          : `no match in the gallery (closest ${(face.similarity || 0).toFixed(2)})`,
      };
    }

    const object = objects[0];
    if (object) {
      return {
        kind: 'object',
        label: object.label,
        confidence: object.score,
        detail: object.refined
          ? `detector said ${object.detectorLabel} ${object.detectorScore.toFixed(2)}`
          : 'object detector',
      };
    }

    if (text) {
      return {
        kind: 'text',
        label: 'Text',
        confidence: (words.confidence || 0) / 100,
        detail: words.reliable
          ? 'read from the region'
          : 'low-confidence read — check the crop against the box',
      };
    }

    if (vocabularyMatch && vocabularyMatch.length) {
      const top = vocabularyMatch[0];
      const second = vocabularyMatch[1];
      const margin = second ? top.score - second.score : top.score;
      if (top.score >= 0.12 && margin >= 0.04) {
        return {
          kind: 'vocabulary',
          label: top.label,
          confidence: top.score,
          detail: `best match in your vocabulary`,
        };
      }
    }

    return { kind: 'none', label: 'Nothing recognised', confidence: 0, detail: 'try a tighter box, or one with more light' };
  }

  /** Choose the face nearest a marked box (or the most prominent one). */
  pickFaceNear(scan, box) {
    if (!scan.faces.length) return null;
    if (!box) return scan.faces[0];
    const W = scan.raw.width;
    const H = scan.raw.height;
    const cx = (box[0] + box[2] / 2) * W;
    const cy = (box[1] + box[3] / 2) * H;
    let best = null;
    for (const f of scan.faces) {
      const fx = f.box[0] + f.box[2] / 2;
      const fy = f.box[1] + f.box[3] / 2;
      const d = Math.hypot(fx - cx, fy - cy);
      if (!best || d < best.d) best = { d, f };
    }
    return best.f;
  }

  /** Crop, save and return the filename of a face thumbnail. */
  async saveFaceThumb(raw, box, prefix = 'face') {
    const buf = await vision.faceThumb(raw, box);
    const name = `${prefix}-${crypto.randomBytes(4).toString('hex')}-${Date.now()}.jpg`;
    await sharp(buf).toFile(db.shotPath(name));
    return name;
  }

  /** Detect faces in an arbitrary uploaded image and return raw vectors for enrolment. */
  async facesInImage(buffer, opts = {}) {
    const settings = db.getSettings();
    const { result, raw } = await vision.analyse(buffer, {
      gallery: [],
      objects: false,
      faces: true,
      faceConfidence: opts.faceConfidence ?? settings.faceConfidence,
    });
    const faces = [];
    for (const f of result.faces) {
      const vector = await vision.embedFace(raw, f.kps);
      if (!vector) continue;
      faces.push({
        box: f.box,
        score: f.score,
        quality: +(f.score * Math.min(1, (f.box[2] * f.box[3]) / (raw.width * raw.height) * 25)).toFixed(3),
        vector,
      });
    }
    faces.sort((a, b) => b.quality - a.quality);
    return { width: raw.width, height: raw.height, faces, raw };
  }
}

module.exports = { Pipeline, vision };
