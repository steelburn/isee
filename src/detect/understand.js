'use strict';
/**
 * "What is this?" — the layer above the detector.
 *
 * YOLOv10 knows 80 COCO classes and nothing else, so a Sharpie becomes the
 * nearest thing in that list (toothbrush). Two extra readers fix that:
 *
 *   CLIP  — open vocabulary. Matches a crop against words an operator chooses.
 *   OCR   — text is not an object class at all, so read it instead of guessing.
 *
 * Both are lazy: nothing loads until the first call, so the fast detection
 * loop is unaffected until someone actually marks a region.
 */
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');
const clip = require('./clip');
const ppocr = require('./ppocr');
const { displayLabel } = require('../vocab');

const MODEL_DIR = path.join(__dirname, '..', '..', 'models');
const TESSDATA = path.join(MODEL_DIR, 'tessdata');

const state = { ocr: 'idle', ocrError: null };
let ocrWorker = null;
let ocrLoading = null;

/* ---------------- OCR ---------------- */

async function loadOcr() {
  if (ocrWorker) return ocrWorker;
  if (ocrLoading) return ocrLoading;
  ocrLoading = (async () => {
    try {
      const { createWorker } = require('tesseract.js');
      fs.mkdirSync(TESSDATA, { recursive: true });
      const worker = await createWorker('eng', 1, { cachePath: TESSDATA });
      ocrWorker = worker;
      state.ocr = 'ready';
      return worker;
    } catch (err) {
      state.ocr = 'error';
      state.ocrError = err.message;
      throw err;
    } finally {
      ocrLoading = null;
    }
  })();
  return ocrLoading;
}

/**
 * Read text from a crop. Returns null when there is nothing worth reporting —
 * an empty wall should not produce "l" with 12% confidence.
 *
 * Tesseract is a document OCR engine: it reads screens, labels and print well,
 * and struggles with soft-focus stylised scene text. We upscale small crops and
 * report the confidence rather than pretending every glyph is certain.
 */
async function readText(buffer, { minConfidence = 35, minChars = 2, mode = 'region' } = {}) {
  // PP-OCRv4 first: it is built for scene text. Tesseract is the fallback for
  // when the Paddle models are absent or the read is too weak to trust.
  if (ppocr.available()) {
    if (!ppocr.ready()) await ppocr.load();
    if (ppocr.ready()) {
      const fast = await ppocr.readText(buffer).catch(() => null);
      if (fast && fast.confidence >= minConfidence && fast.text.trim().length >= minChars) {
        return { ...fast, engine: 'ppocr' };
      }
    }
  }
  return readTesseract(buffer, { minConfidence, minChars, mode });
}

async function readTesseract(buffer, { minConfidence = 35, minChars = 2, mode = 'region' } = {}) {
  const t0 = Date.now();
  let worker;
  try {
    worker = await loadOcr();
  } catch {
    return null;
  }
  try {
    const meta = await sharp(buffer).metadata();
    let pipe = sharp(buffer);
    if (meta.width && meta.width < 900) {
      pipe = pipe.resize(Math.min(2400, meta.width * 2), null, { kernel: 'lanczos3' });
    }
    const prepared = await pipe.grayscale().normalise().jpeg({ quality: 92 }).toBuffer();

    await worker.setParameters({ tessedit_pageseg_mode: mode === 'region' ? '6' : '3' });
    const { data } = await worker.recognize(prepared);

    const text = String(data.text || '').replace(/\s+/g, ' ').trim();
    const meaningful = (text.match(/[\p{L}\p{N}]/gu) || []).length;
    if (!text || text.length < minChars || meaningful < minChars) return null;
    const confidence = Math.round(Number(data.confidence || 0));
    if (confidence < minConfidence) return null;
    return {
      text: text.length > 240 ? `${text.slice(0, 240)}…` : text,
      confidence,
      reliable: confidence >= 60 && text.length >= 3,
      engine: 'tesseract',
      ms: Date.now() - t0,
    };
  } catch (err) {
    state.ocrError = err.message;
    return null;
  }
}

/* ---------------- open vocabulary ---------------- */

/**
 * Rank a crop against prompts. Returns display labels, highest first.
 * `extra` prompts are prepended so the detector's own guess is always in play
 * and can never be silently outvoted by a word it was never allowed to say.
 */
async function describe(buffer, prompts = [], extra = []) {
  const list = [...new Set([...extra, ...prompts].map((p) => String(p).trim()).filter(Boolean))];
  if (!list.length) return [];
  const ranked = await clip.rank(buffer, list);
  return ranked.map((r) => ({
    label: displayLabel(r.label),
    prompt: r.label,
    score: r.score,
  }));
}

function ready() {
  return { clip: clip.ready(), ocr: state.ocr === 'ready', ppocr: ppocr.ready() };
}

async function status() {
  return {
    clip: clip.status(),
    ocr: { status: state.ocr, error: state.ocrError },
    ppocr: ppocr.status(),
  };
}

async function warm() {
  const out = { clip: null, ocr: null, ppocr: null };
  try { out.clip = await clip.load(); } catch (e) { out.clip = { status: 'error', error: e.message }; }
  try { await loadOcr(); out.ocr = 'ready'; } catch (e) { out.ocr = 'error'; }
  try {
    const r = await ppocr.load();
    out.ppocr = r.status;
  } catch (e) { out.ppocr = 'error'; }
  return out;
}

module.exports = { readText, readTesseract, describe, warm, ready, status, clip, ppocr };
