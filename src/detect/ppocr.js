'use strict';
/**
 * PP-OCRv4 (PaddleOCR) as plain ONNX — scene text, not document text.
 *
 * Two models: DB text detection produces a probability map of text regions,
 * then SVTR-LCNet recognition reads each line with a CTC head. This is the
 * engine to reach for when the subject is a label on a box in bad light, which
 * is exactly where tesseract gives up.
 */
const path = require('node:path');
const fs = require('node:fs');
const ort = require('onnxruntime-node');
const sharp = require('sharp');

const MODEL_DIR = path.join(__dirname, '..', '..', 'models');
const DET = path.join(MODEL_DIR, 'ppocr_det.onnx');
const REC = path.join(MODEL_DIR, 'ppocr_rec.onnx');
const KEYS = path.join(MODEL_DIR, 'ppocr_keys.txt');

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const REC_HEIGHT = 48;
const REC_MAX_WIDTH = 320;

const state = { status: 'idle', error: null, ms: null };
const sessions = { det: null, rec: null };
let charset = null;

function available() {
  return fs.existsSync(DET) && fs.existsSync(REC) && fs.existsSync(KEYS);
}

async function load() {
  if (state.status === 'ready' || state.status === 'loading') return state;
  if (!available()) {
    state.status = 'missing';
    state.error = 'PP-OCRv4 models are not in models/';
    return state;
  }
  const t0 = Date.now();
  state.status = 'loading';
  try {
    const opts = { intraOpNumThreads: 2, graphOptimizationLevel: 'all' };
    sessions.det = await ort.InferenceSession.create(DET, opts);
    sessions.rec = await ort.InferenceSession.create(REC, opts);
    // PaddleOCR: index 0 is the CTC blank, then the dictionary, then space
    charset = ['', ...fs.readFileSync(KEYS, 'utf8').split(/\r?\n/).filter((l) => l.length), ' '];
    state.status = 'ready';
    state.ms = Date.now() - t0;
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
  }
  return state;
}

function ready() { return state.status === 'ready'; }
function status() { return { ...state, classes: charset ? charset.length : 0 }; }

/* ---------------- preprocessing ---------------- */

function nearest32(v) {
  return Math.max(32, Math.round(v / 32) * 32);
}

async function detTensor(jpeg, maxSide) {
  const meta = await sharp(jpeg).metadata();
  const ratio = Math.min(1, maxSide / Math.max(meta.width, meta.height));
  const w = nearest32(meta.width * ratio);
  const h = nearest32(meta.height * ratio);

  const { data } = await sharp(jpeg).resize(w, h, { fit: 'fill' }).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });

  const plane = w * h;
  const t = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      t[c * plane + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  return { tensor: new ort.Tensor('float32', t, [1, 3, h, w]), w, h, srcW: meta.width, srcH: meta.height };
}

/** Connected components of the DB map, keeping their pixels so we can fit a
 *  rotated rectangle rather than a bounding box. */
function components(prob, W, H, { thresh = 0.3, boxThresh = 0.5, minArea = 10 } = {}) {
  const bin = new Uint8Array(W * H);
  const seen = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bin[i] = prob[i] > thresh ? 1 : 0;

  const stack = new Int32Array(W * H);
  const out = [];

  for (let start = 0; start < W * H; start++) {
    if (!bin[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    const xs = [];
    const ys = [];
    let sum = 0;
    let minX = W, maxX = -1, minY = H, maxY = -1;

    while (sp > 0) {
      const p = stack[--sp];
      const py = (p / W) | 0;
      const px = p - py * W;
      xs.push(px);
      ys.push(py);
      sum += prob[p];
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= W) continue;
          const q = ny * W + nx;
          if (bin[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
        }
      }
    }

    const count = xs.length;
    if (count < minArea || maxX - minX + 1 < 3 || maxY - minY + 1 < 3) continue;
    if (sum / count < boxThresh) continue;
    out.push({ xs, ys, count, score: sum / count, minX, minY, maxX, maxY });
  }
  return out;
}

/** Glue components that share a line: same band, small horizontal gap. */
function groupLines(comps, mergeGap = 0.35) {
  const sorted = comps.slice().sort((a, b) => a.minY - b.minY || a.minX - b.minX);
  const groups = [];
  for (const c of sorted) {
    const g = groups[groups.length - 1];
    if (g) {
      const hA = g.maxY - g.minY;
      const hB = c.maxY - c.minY;
      const overlap = Math.min(g.maxY, c.maxY) - Math.max(g.minY, c.minY);
      const gap = c.minX - g.maxX;
      if (overlap > 0.5 * Math.min(hA, hB) && gap < mergeGap * Math.max(hA, hB)) {
        g.xs.push(...c.xs);
        g.ys.push(...c.ys);
        g.count += c.count;
        g.score = Math.max(g.score, c.score);
        g.minX = Math.min(g.minX, c.minX);
        g.minY = Math.min(g.minY, c.minY);
        g.maxX = Math.max(g.maxX, c.maxX);
        g.maxY = Math.max(g.maxY, c.maxY);
        continue;
      }
    }
    groups.push({ ...c, xs: c.xs.slice(), ys: c.ys.slice() });
  }
  return groups;
}

/**
 * Oriented rectangle for one line, from second moments. Packaging print is
 * rarely level, and an axis-aligned box around a 9-degree slope is mostly
 * background — that is what was costing us the start of the carton line.
 */
function orientedRect(group, unclip = 1.6) {
  const { xs, ys } = group;
  const n = xs.length;
  let mx = 0; let my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n;
  my /= n;

  let sxx = 0; let syy = 0; let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  let deg = (0.5 * Math.atan2(2 * sxy, sxx - syy)) * 180 / Math.PI;
  if (deg > 90) deg -= 180;
  if (deg <= -90) deg += 180;

  const rad = deg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  let minU = Infinity; let maxU = -Infinity; let minV = Infinity; let maxV = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    const u = dx * cos + dy * sin;
    const v = -dx * sin + dy * cos;
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }

  const w = maxU - minU;
  const h = maxV - minV;
  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;

  const grow = (w * h * unclip) / (2 * (w + h));
  const W = w + grow * 2;
  const H = h + grow * 2;

  return {
    cx: mx + cu * cos - cv * sin,
    cy: my + cu * sin + cv * cos,
    w: W,
    h: H,
    angle: rad,
    score: group.score,
    // bounding box, for merging/ordering/debug
    x0: group.minX, y0: group.minY, x1: group.maxX + 1, y1: group.maxY + 1,
  };
}

function rectAABB(rect, srcW, srcH) {
  const cos = Math.abs(Math.cos(rect.angle));
  const sin = Math.abs(Math.sin(rect.angle));
  const w = rect.w * cos + rect.h * sin;
  const h = rect.w * sin + rect.h * cos;
  const left = Math.max(0, Math.floor(rect.cx - w / 2) - 2);
  const top = Math.max(0, Math.floor(rect.cy - h / 2) - 2);
  return {
    left,
    top,
    width: Math.max(4, Math.min(srcW - left, Math.ceil(w) + 4)),
    height: Math.max(4, Math.min(srcH - top, Math.ceil(h) + 4)),
  };
}

/**
 * Straighten a sloped line into a horizontal strip so the recogniser sees the
 * script the way it was trained: level, tightly framed, no background wedge.
 */
async function warpLine(src, rect, srcW, srcH) {
  const deg = (rect.angle * 180) / Math.PI;
  if (Math.abs(deg) < 2) {
    const a = rectAABB(rect, srcW, srcH);
    return sharp(src).extract(a).png().toBuffer();
  }

  const a = rectAABB(rect, srcW, srcH);
  const region = await sharp(src).extract(a).png().toBuffer();

  // fill the rotation wedge with the paper colour, not white
  let bg = { r: 200, g: 200, b: 200 };
  try {
    const st = await sharp(region).stats();
    bg = {
      r: Math.round(st.channels[0].mean),
      g: Math.round(st.channels[1].mean),
      b: Math.round(st.channels[2].mean),
    };
  } catch { /* keep the neutral fill */ }

  const rotated = await sharp(region).rotate(-deg, { background: bg }).png().toBuffer();
  const rmeta = await sharp(rotated).metadata();
  const cw = Math.max(8, Math.min(rmeta.width, Math.round(rect.w)));
  const ch = Math.max(8, Math.min(rmeta.height, Math.round(rect.h)));
  const left = Math.max(0, Math.round((rmeta.width - cw) / 2));
  const top = Math.max(0, Math.round((rmeta.height - ch) / 2));

  return sharp(rotated)
    .extract({ left, top, width: cw, height: ch })
    .png()
    .toBuffer();
}

async function recLine(src, rect, srcW, srcH) {
  let crop;
  try {
    crop = await warpLine(src, rect, srcW, srcH);
  } catch {
    return null;
  }
  const best = await recognize(crop);
  return best ? { ...best, box: { x: Math.round(rect.cx), y: Math.round(rect.cy), w: rect.w, h: rect.h } } : null;
}

async function recognize(crop) {
  const src = await sharp(crop).metadata();
  const targetW = Math.min(REC_MAX_WIDTH, Math.max(16, Math.round((REC_HEIGHT * src.width) / src.height)));
  const { data } = await sharp(crop)
    .resize(targetW, REC_HEIGHT, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const plane = REC_HEIGHT * targetW;
  const t = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      t[c * plane + i] = (data[i * 3 + c] / 255 - 0.5) / 0.5;
    }
  }

  const out = await sessions.rec.run({ x: new ort.Tensor('float32', t, [1, 3, REC_HEIGHT, targetW]) });
  const o = out[sessions.rec.outputNames[0]];
  const steps = o.dims[1];
  const classes = o.dims[2];
  const d = o.data;

  // First pass: which timesteps emitted a glyph.
  const glyphs = [];
  let prev = -1;
  for (let s = 0; s < steps; s++) {
    let bestC = 0;
    let bestP = d[s * classes];
    for (let c = 1; c < classes; c++) {
      const v = d[s * classes + c];
      if (v > bestP) { bestP = v; bestC = c; }
    }
    if (bestC !== 0 && bestC !== prev) glyphs.push({ step: s, cls: bestC, prob: bestP });
    prev = bestC;
  }
  if (!glyphs.length) return null;

  // Word gaps are outlier gaps in this line's own rhythm, so the threshold is
  // relative: an evenly lettered word never grows a space, a real one does.
  const gaps = [];
  for (let i = 1; i < glyphs.length; i++) gaps.push(glyphs[i].step - glyphs[i - 1].step);
  const sortedGaps = gaps.slice().sort((a, b) => a - b);
  const median = sortedGaps.length ? sortedGaps[sortedGaps.length >> 1] : 1;
  const wordGap = Math.max(3, median * 2.2);

  let text = '';
  let probSum = 0;
  for (let i = 0; i < glyphs.length; i++) {
    if (i > 0 && glyphs[i].step - glyphs[i - 1].step >= wordGap) text += ' ';
    text += charset[glyphs[i].cls] ?? '';
    probSum += glyphs[i].prob;
  }
  const kept = glyphs.length;
  if (!text.trim()) return null;
  return {
    text,
    confidence: Math.round((probSum / Math.max(1, kept)) * 100),
  };
}

const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/g;
const LATIN = /[A-Za-z]/g;

/**
 * The v4 recogniser carries a Chinese charset. On a noisy Latin crop it will
 * sometimes emit a CJK glyph for a blob that is really a letter. Mixed scripts
 * in one line are almost always that, so keep the Latin and drop the rest;
 * a line that is genuinely Chinese has no Latin in it and is left alone.
 */
function demixScripts(text) {
  const latin = (text.match(LATIN) || []).length;
  const cjk = (text.match(CJK) || []).length;
  if (!latin || !cjk) return text;
  return text.replace(CJK, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Read text from an image. Returns null when nothing worth reporting is found,
 * so a blank wall never produces a confident-looking string.
 */
async function readText(jpeg, opts = {}) {
  if (!ready()) await load();
  if (!ready()) return null;

  const maxSide = opts.maxSide || 1280;
  const t0 = Date.now();

  // Small crops lose detail when the detector downsizes them. Giving it more
  // pixels roughly halves the character error on this hardware, so upscale
  // anything that is not already a large frame.
  let source = jpeg;
  let meta0;
  try { meta0 = await sharp(jpeg).metadata(); } catch { return null; }
  if (meta0.width && meta0.height) {
    let k = 1;
    if (meta0.width <= 640 && meta0.height <= 160) k = 2;
    if (meta0.height < 64) k = Math.max(k, Math.min(3, 64 / meta0.height));
    k = Math.min(k, Math.max(1, 1600 / meta0.width));
    if (k > 1.05) {
      source = await sharp(jpeg)
        .resize(Math.round(meta0.width * k), Math.round(meta0.height * k), { kernel: 'lanczos3' })
        .jpeg({ quality: 95 })
        .toBuffer();
    }
  }

  const { tensor, w, h, srcW, srcH } = await detTensor(source, maxSide);

  const out = await sessions.det.run({ x: tensor });
  const prob = out[sessions.det.outputNames[0]].data;
  const groups = groupLines(components(prob, w, h, {
    thresh: opts.detThresh ?? 0.3,
    boxThresh: opts.boxThresh ?? 0.5,
  }), opts.mergeGap ?? 0.35);
  if (!groups.length) return null;

  // detection ran on a resized copy; map the rects back to the source frame
  const scaleX = srcW / w;
  const scaleY = srcH / h;
  const rects = groups.map((g) => {
    const r = orientedRect(g, opts.unclip ?? 1.6);
    return {
      ...r,
      cx: r.cx * scaleX,
      cy: r.cy * scaleY,
      w: r.w * scaleX,
      h: r.h * scaleY,
      x0: r.x0 * scaleX, y0: r.y0 * scaleY, x1: r.x1 * scaleX, y1: r.y1 * scaleY,
    };
  }).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

  const lines = [];
  for (const rect of rects.slice(0, 24)) {
    if (rect.w < 4 || rect.h < 4) continue;
    // vertical or absurdly oblique: leave it to the upright crop
    const tilt = Math.abs((rect.angle * 180) / Math.PI);
    if (tilt > 45) rect.angle = 0;
    const line = await recLine(source, rect, srcW, srcH);
    if (!line) continue;
    if (line.confidence < 25) continue; // a blob, not a word
    line.text = demixScripts(line.text);
    if (line.text.trim()) lines.push(line);
  }
  if (!lines.length) return null;

  // words on one line become "a b", separate lines become "a\nb"
  const ordered = lines.slice().sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  let text = ordered[0].text.trim();
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1].box;
    const cur = ordered[i].box;
    const overlap = Math.min(prev.y + prev.h, cur.y + cur.h) - Math.max(prev.y, cur.y);
    const sameLine = overlap > 0.5 * Math.min(prev.h, cur.h);
    text += sameLine ? ` ${ordered[i].text.trim()}` : `\n${ordered[i].text.trim()}`;
  }

  const confidence = Math.round(
    ordered.reduce((acc, l) => acc + l.confidence, 0) / ordered.length,
  );
  return {
    text: text.length > 240 ? `${text.slice(0, 240)}…` : text,
    confidence,
    reliable: confidence >= 60 && text.replace(/\s/g, '').length >= 3,
    blocks: ordered.length,
    boxes: ordered.map((l) => l.box),
    engine: 'ppocr',
    ms: Date.now() - t0,
  };
}

module.exports = { load, ready, status, readText, available, components, groupLines, orientedRect };
