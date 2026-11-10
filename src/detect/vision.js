'use strict';
const path = require('node:path');
const fs = require('node:fs');
const ort = require('onnxruntime-node');
const sharp = require('sharp');

const MODELS = path.join(__dirname, '..', '..', 'models');

const COCO = ('person,bicycle,car,motorcycle,airplane,bus,train,truck,boat,traffic light,fire hydrant,stop sign,' +
  'parking meter,bench,bird,cat,dog,horse,sheep,cow,elephant,bear,zebra,giraffe,backpack,umbrella,handbag,tie,' +
  'suitcase,frisbee,skis,snowboard,sports ball,kite,baseball bat,baseball glove,skateboard,surfboard,tennis racket,' +
  'bottle,wine glass,cup,fork,knife,spoon,bowl,banana,apple,sandwich,orange,broccoli,carrot,hot dog,pizza,donut,' +
  'cake,chair,couch,potted plant,bed,dining table,toilet,tv,laptop,mouse,remote,keyboard,cell phone,microwave,' +
  'oven,toaster,sink,refrigerator,book,clock,vase,scissors,teddy bear,hair drier,toothbrush').split(',');

// Standard ArcFace 5-point template (112x112).
const ARCFACE_TEMPLATE = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
  [41.5493, 92.3655], [70.7299, 92.2041],
];

const state = { status: 'loading', error: null, loadedAt: null, ms: null };

const sessions = { objects: null, faces: null, embed: null };

/* ------------------------------------------------------------------ */
/* image helpers                                                       */
/* ------------------------------------------------------------------ */

async function decodeRaw(jpegBuffer) {
  const { data, info } = await sharp(jpegBuffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // normalise to 3 channels regardless of source
  if (info.channels === 3) return { data, width: info.width, height: info.height };
  const out = Buffer.alloc(info.width * info.height * 3);
  for (let i = 0, j = 0; i < data.length; i += info.channels, j += 3) {
    out[j] = data[i]; out[j + 1] = data[i + 1]; out[j + 2] = data[i + 2];
  }
  return { data: out, width: info.width, height: info.height };
}

function rgbToTensor(raw, size) {
  // reproduce cv2.dnn.blobFromImage(im, 1/128, (s,s), (127.5,..), swapRB=True)
  const t = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let i = 0; i < plane; i++) {
    t[i] = (raw.data[i * 3] - 127.5) / 128;
    t[plane + i] = (raw.data[i * 3 + 1] - 127.5) / 128;
    t[2 * plane + i] = (raw.data[i * 3 + 2] - 127.5) / 128;
  }
  return t;
}

/* ------------------------------------------------------------------ */
/* model loading                                                       */
/* ------------------------------------------------------------------ */

async function loadModels() {
  const t0 = Date.now();
  try {
    const opts = { intraOpNumThreads: 2, graphOptimizationLevel: 'all' };
    sessions.objects = await ort.InferenceSession.create(path.join(MODELS, 'yolov10n.onnx'), opts);
    sessions.faces = await ort.InferenceSession.create(path.join(MODELS, 'face_det.onnx'), opts);
    sessions.embed = await ort.InferenceSession.create(path.join(MODELS, 'face_rec.onnx'), opts);
    state.status = 'ready';
    state.loadedAt = Date.now();
    state.ms = state.loadedAt - t0;

    // warm-up so the first real frame is not 4x slower
    const blank = await sharp({ create: { width: 640, height: 640, channels: 3, background: '#000' } })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    await runObjects({ data: blank.data, width: 640, height: 640 }, 0.99);
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
    throw err;
  }
  return state;
}

function modelsReady() { return state.status === 'ready'; }
function modelStatus() {
  return { ...state, models: { objects: !!sessions.objects, faces: !!sessions.faces, embed: !!sessions.embed } };
}

/* ------------------------------------------------------------------ */
/* object detection — YOLOv10n, NMS-free, output [1,300,6]             */
/* ------------------------------------------------------------------ */

async function runObjects(raw, threshold = 0.45) {
  const S = 640;
  const { width: w, height: h } = raw;
  const scale = Math.min(S / w, S / h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const padX = Math.floor((S - nw) / 2);
  const padY = Math.floor((S - nh) / 2);

  // letterbox this raw buffer into a square canvas
  const canvas = new Uint8Array(S * S * 3).fill(114);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor(x / scale));
      const si = (sy * w + sx) * 3;
      const di = ((y + padY) * S + (x + padX)) * 3;
      canvas[di] = raw.data[si];
      canvas[di + 1] = raw.data[si + 1];
      canvas[di + 2] = raw.data[si + 2];
    }
  }

  const plane = S * S;
  const tensor = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    tensor[i] = canvas[i * 3] / 255;
    tensor[plane + i] = canvas[i * 3 + 1] / 255;
    tensor[2 * plane + i] = canvas[i * 3 + 2] / 255;
  }

  const out = await sessions.objects.run({
    [sessions.objects.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, S, S]),
  });
  const o = out[sessions.objects.outputNames[0]];
  const rows = o.dims[1];
  const stride = o.dims[2];
  const d = o.data;

  const dets = [];
  for (let i = 0; i < rows; i++) {
    const base = i * stride;
    const score = d[base + 4];
    if (score < threshold) continue;
    const classId = Math.round(d[base + 5]);
    if (classId < 0 || classId >= COCO.length) continue;
    const x1 = (d[base] - padX) / scale;
    const y1 = (d[base + 1] - padY) / scale;
    const x2 = (d[base + 2] - padX) / scale;
    const y2 = (d[base + 3] - padY) / scale;
    const bw = x2 - x1;
    const bh = y2 - y1;
    if (bw < 4 || bh < 4) continue;
    dets.push({
      label: COCO[classId],
      classId,
      score: +score.toFixed(4),
      box: [
        +Math.max(0, x1 / w).toFixed(4),
        +Math.max(0, y1 / h).toFixed(4),
        +Math.min(1, bw / w).toFixed(4),
        +Math.min(1, bh / h).toFixed(4),
      ],
    });
  }
  dets.sort((a, b) => b.score - a.score);
  return dets.slice(0, 50);
}

/* ------------------------------------------------------------------ */
/* face detection — SCRFD 10g, 3 strides x 2 anchors, 5 keypoints      */
/* ------------------------------------------------------------------ */

function iou(a, b) {
  const ax2 = a[0] + a[2], ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2], by2 = b[1] + b[3];
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  return inter / (a[2] * a[3] + b[2] * b[3] - inter + 1e-9);
}

function nms(boxes, thr = 0.4) {
  const order = boxes.map((b, i) => [b.score, i]).sort((x, y) => y[0] - x[0]);
  const keep = [];
  const suppressed = new Set();
  for (const [, i] of order) {
    if (suppressed.has(i)) continue;
    keep.push(i);
    for (const [, j] of order) {
      if (j !== i && !suppressed.has(j) && iou(boxes[i].box, boxes[j].box) > thr) suppressed.add(j);
    }
  }
  return keep.map((i) => boxes[i]);
}

async function runFaces(raw, threshold = 0.5) {
  const S = 640;
  const { width: w, height: h } = raw;

  // SCRFD is trained on a stretched square input
  const sq = new Uint8Array(S * S * 3);
  for (let y = 0; y < S; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / S));
    for (let x = 0; x < S; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / S));
      const si = (sy * w + sx) * 3;
      const di = (y * S + x) * 3;
      sq[di] = raw.data[si]; sq[di + 1] = raw.data[si + 1]; sq[di + 2] = raw.data[si + 2];
    }
  }
  const tensor = rgbToTensor({ data: sq }, S);

  const out = await sessions.faces.run({
    [sessions.faces.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, S, S]),
  });
  const names = sessions.faces.outputNames;
  const strides = [8, 16, 32];

  const candidates = [];
  for (let s = 0; s < 3; s++) {
    const stride = strides[s];
    const scores = out[names[s]].data;
    const bboxs = out[names[s + 3]].data;
    const kpss = out[names[s + 6]].data;
    const n = out[names[s]].dims[0];
    const fw = Math.ceil(S / stride);
    const fh = Math.ceil(S / stride);
    const anchors = 2;

    for (let idx = 0; idx < n; idx++) {
      const score = scores[idx];
      if (score < threshold) continue;
      const anchorIdx = (idx / anchors) | 0;
      const gx = anchorIdx % fw;
      const gy = (anchorIdx / fw) | 0;
      if (gy >= fh) continue;
      const cx = gx * stride;
      const cy = gy * stride;

      const b = idx * 4;
      const x1 = cx - bboxs[b] * stride;
      const y1 = cy - bboxs[b + 1] * stride;
      const x2 = cx + bboxs[b + 2] * stride;
      const y2 = cy + bboxs[b + 3] * stride;
      if (x2 - x1 < 8 || y2 - y1 < 8) continue;

      const k = idx * 10;
      const kps = [];
      for (let p = 0; p < 5; p++) {
        kps.push([
          (cx + kpss[k + p * 2] * stride) * (w / S),
          (cy + kpss[k + p * 2 + 1] * stride) * (h / S),
        ]);
      }

      candidates.push({
        score: +score.toFixed(4),
        box: [(x1 * w) / S, (y1 * h) / S, ((x2 - x1) * w) / S, ((y2 - y1) * h) / S],
        kps,
      });
    }
  }

  const kept = nms(candidates, 0.4).slice(0, 20);
  return kept.map((f) => ({
    ...f,
    box: [+f.box[0].toFixed(1), +f.box[1].toFixed(1), +f.box[2].toFixed(1), +f.box[3].toFixed(1)],
    kps: f.kps.map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)]),
  }));
}

/* ------------------------------------------------------------------ */
/* face alignment + embedding — ArcFace w600k_r50                      */
/* ------------------------------------------------------------------ */

/** Least-squares similarity transform src -> dst: [a -b; b a] p + t. */
function similarityTransform(src, dst) {
  // normal equations for params (a, b, tx, ty)
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const Bv = [0, 0, 0, 0];
  for (let i = 0; i < src.length; i++) {
    const [sx, sy] = src[i];
    const [dx, dy] = dst[i];
    // row for dx: a*sx - b*sy + tx*1 + ty*0
    const r1 = [sx, -sy, 1, 0];
    const r2 = [sy, sx, 0, 1];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        A[r][c] += r1[r] * r1[c] + r2[r] * r2[c];
      }
      Bv[r] += r1[r] * dx + r2[r] * dy;
    }
  }
  // gaussian elimination
  for (let i = 0; i < 4; i++) {
    let piv = i;
    for (let r = i + 1; r < 4; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    if (Math.abs(A[piv][i]) < 1e-9) return null;
    [A[i], A[piv]] = [A[piv], A[i]];
    [Bv[i], Bv[piv]] = [Bv[piv], Bv[i]];
    const d = A[i][i];
    for (let c = i; c < 4; c++) A[i][c] /= d;
    Bv[i] /= d;
    for (let r = 0; r < 4; r++) {
      if (r === i) continue;
      const f = A[r][i];
      if (!f) continue;
      for (let c = i; c < 4; c++) A[r][c] -= f * A[i][c];
      Bv[r] -= f * Bv[i];
    }
  }
  const [a, b, tx, ty] = Bv;
  return { a, b, tx, ty };
}

const OUT = 112;

/** Warp an aligned 112x112 RGB patch out of the full frame using kps. */
function alignFace(raw, kps) {
  const m = similarityTransform(kps, ARCFACE_TEMPLATE);
  if (!m) return null;
  const { a, b, tx, ty } = m;
  const det = a * a + b * b;
  if (det < 1e-9) return null;

  const out = new Uint8Array(OUT * OUT * 3);
  const { data, width: w, height: h } = raw;

  for (let oy = 0; oy < OUT; oy++) {
    for (let ox = 0; ox < OUT; ox++) {
      const dx = ox + 0.5, dy = oy + 0.5;
      const px = dx - tx, py = dy - ty;
      // inverse of [[a,-b],[b,a]]
      const sx = (a * px + b * py) / det - 0.5;
      const sy = (-b * px + a * py) / det - 0.5;

      const oi = (oy * OUT + ox) * 3;
      if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) {
        out[oi] = 0; out[oi + 1] = 0; out[oi + 2] = 0;
        continue;
      }
      const x0 = sx | 0, y0 = sy | 0;
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * w + x0) * 3;
      const i01 = i00 + 3;
      const i10 = ((y0 + 1) * w + x0) * 3;
      const i11 = i10 + 3;
      for (let c = 0; c < 3; c++) {
        const top = data[i00 + c] + (data[i01 + c] - data[i00 + c]) * fx;
        const bot = data[i10 + c] + (data[i11 + c] - data[i10 + c]) * fx;
        out[oi + c] = top + (bot - top) * fy;
      }
    }
  }
  return out;
}

function normalizeEmbedding(vec) {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

async function embedFace(raw, kps) {
  const patch = alignFace(raw, kps);
  if (!patch) return null;
  const t = new Float32Array(3 * OUT * OUT);
  const plane = OUT * OUT;
  for (let i = 0; i < plane; i++) {
    t[i] = (patch[i * 3] - 127.5) / 127.5;
    t[plane + i] = (patch[i * 3 + 1] - 127.5) / 127.5;
    t[2 * plane + i] = (patch[i * 3 + 2] - 127.5) / 127.5;
  }
  const out = await sessions.embed.run({
    [sessions.embed.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, OUT, OUT]),
  });
  return normalizeEmbedding(out[sessions.embed.outputNames[0]].data);
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/* ------------------------------------------------------------------ */
/* full frame analysis                                                 */
/* ------------------------------------------------------------------ */

async function analyse(jpegBuffer, { gallery = [], objects = true, faces = true, objectConfidence = 0.45, faceConfidence = 0.5, matchThreshold = 0.42 } = {}) {
  if (!modelsReady()) throw new Error('models are still loading');
  const raw = await decodeRaw(jpegBuffer);
  const result = { width: raw.width, height: raw.height, objects: [], faces: [] };

  if (objects) result.objects = await runObjects(raw, objectConfidence);

  if (faces) {
    const dets = await runFaces(raw, faceConfidence);
    for (const d of dets) {
      const vector = await embedFace(raw, d.kps);
      if (!vector) continue;
      let best = null;
      for (const g of gallery) {
        const sim = cosine(vector, g.vector);
        if (!best || sim > best.similarity) best = { similarity: sim, ...g };
      }
      const matched = best && best.similarity >= matchThreshold ? best : null;
      result.faces.push({
        box: d.box,
        kps: d.kps,
        score: d.score,
        personId: matched ? matched.personId : null,
        name: matched ? matched.personName : null,
        similarity: best ? +best.similarity.toFixed(4) : null,
      });
    }
  }

  // keep the aligned thumbnail of the most prominent face for enrolment previews
  return { result, raw };
}

async function faceThumb(raw, boxPx) {
  const [x, y, w, h] = boxPx;
  const pad = 0.18;
  const left = Math.max(0, Math.round(x - w * pad));
  const top = Math.max(0, Math.round(y - h * pad));
  const width = Math.max(8, Math.round(Math.min(raw.width - left, w * (1 + pad * 2))));
  const height = Math.max(8, Math.round(Math.min(raw.height - top, h * (1 + pad * 2))));
  return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 3 } })
    .extract({ left, top, width, height })
    .resize(160, 160, { fit: 'cover' })
    .jpeg({ quality: 82 })
    .toBuffer();
}

module.exports = {
  COCO,
  loadModels, modelsReady, modelStatus,
  decodeRaw, runObjects, runFaces, embedFace, alignFace, cosine,
  analyse, faceThumb, ARCFACE_TEMPLATE,
};
