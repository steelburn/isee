'use strict';
/**
 * CLIP ViT-B/32 as plain ONNX on the runtime we already ship.
 *
 * No transformers.js: that library's bundled natives segfault when loaded
 * alongside our sharp/onnxruntime pair, so we tokenise and preprocess here.
 * Byte-level BPE is the standard GPT-2 scheme, verified against known-good
 * scores on a reference image.
 */
const path = require('node:path');
const fs = require('node:fs');
const ort = require('onnxruntime-node');
const sharp = require('sharp');

const MODEL_DIR = path.join(__dirname, '..', '..', 'models');
const TOKENIZER = path.join(MODEL_DIR, 'clip_tokenizer.json');

const SOT = 49406; // <|startoftext|>
const EOT = 49407; // <|endoftext|>
const CONTEXT = 77;

const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];

/* ---------------- byte-level BPE ---------------- */

const bytesToUnicode = (() => {
  const bs = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  }
  const map = new Map();
  for (let i = 0; i < bs.length; i++) map.set(bs[i], String.fromCharCode(cs[i]));
  return map;
})();

/** CLIP's own pattern (OpenAI simple_tokenizer): pieces carry `</w>`, not `Ġ`. */
const PRETOKENIZE = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/gu;

let tokenizer = null;

function loadTokenizer() {
  if (tokenizer) return tokenizer;
  const raw = JSON.parse(fs.readFileSync(TOKENIZER, 'utf8'));
  const vocab = raw.model.vocab;
  const ranks = new Map();
  (raw.model.merges || []).forEach((m, i) => ranks.set(m, i));
  tokenizer = { vocab, ranks };
  return tokenizer;
}

function bpe(piece, ranks) {
  const chars = [...piece];
  if (!chars.length) return [];
  // CLIP marks the end of a word on its final character
  chars[chars.length - 1] = `${chars[chars.length - 1]}</w>`;
  let word = chars;
  if (word.length < 2) return word;
  for (;;) {
    let bestRank = Infinity;
    let bestAt = -1;
    for (let i = 0; i < word.length - 1; i++) {
      const rank = ranks.get(`${word[i]} ${word[i + 1]}`);
      if (rank !== undefined && rank < bestRank) { bestRank = rank; bestAt = i; }
    }
    if (bestAt === -1) break;
    word = [
      ...word.slice(0, bestAt),
      word[bestAt] + word[bestAt + 1],
      ...word.slice(bestAt + 2),
    ];
  }
  return word;
}

function encodeText(text) {
  const { vocab, ranks } = loadTokenizer();
  const normalised = text.normalize('NFC').replace(/\s+/g, ' ').toLowerCase().trim();
  const ids = [SOT];
  for (const match of normalised.matchAll(PRETOKENIZE)) {
    const piece = [...match[0]].map((ch) => bytesToUnicode.get(ch.codePointAt(0)) ?? ch).join('');
    for (const token of bpe(piece, ranks)) {
      const id = vocab[token];
      if (id !== undefined) ids.push(id);
    }
  }
  ids.push(EOT);
  return ids.slice(0, CONTEXT);
}

/** Inverse of encodeText, for tests: ids -> text. */
function decodeText(ids) {
  const { vocab } = loadTokenizer();
  const inverse = new Map();
  for (const [token, id] of Object.entries(vocab)) inverse.set(id, token);
  const decoder = new Map();
  for (const [byte, ch] of bytesToUnicode) decoder.set(ch, byte);
  let out = '';
  for (const id of ids) {
    if (id === SOT || id === EOT) continue;
    let token = inverse.get(id) || '';
    const isEnd = token.endsWith('</w>');
    if (isEnd) token = token.slice(0, -4);
    for (const ch of token) {
      const b = decoder.get(ch);
      if (b !== undefined) out += String.fromCharCode(b);
    }
    if (isEnd) out += ' ';
  }
  return out.trim();
}

/* ---------------- model ---------------- */

const state = { status: 'idle', error: null, ms: null };
const sessions = { vision: null, text: null };
const textCache = new Map();
let textCacheFile = path.join(MODEL_DIR, 'clip-text-cache.json');

function loadTextCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(textCacheFile, 'utf8'));
    for (const [k, v] of Object.entries(raw)) textCache.set(k, Float32Array.from(v));
  } catch { /* first run */ }
}

let saveTimer = null;
function saveTextCacheSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const out = {};
      for (const [k, v] of textCache) out[k] = Array.from(v);
      fs.writeFileSync(textCacheFile, JSON.stringify(out));
    } catch { /* cache is an optimisation only */ }
  }, 800);
}

async function load() {
  if (state.status === 'ready' || state.status === 'loading') return state;
  const t0 = Date.now();
  state.status = 'loading';
  try {
    const opts = { intraOpNumThreads: 2, graphOptimizationLevel: 'all' };
    const visionPath = pickModel('clip_vision');
    const textPath = pickModel('clip_text');
    if (!visionPath || !textPath) throw new Error('CLIP models missing from models/');
    sessions.vision = await ort.InferenceSession.create(visionPath, opts);
    sessions.text = await ort.InferenceSession.create(textPath, opts);
    loadTokenizer();
    loadTextCache();
    state.status = 'ready';
    state.ms = Date.now() - t0;
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
  }
  return state;
}

function pickModel(base) {
  for (const name of [`${base}_quantized.onnx`, `${base}.onnx`]) {
    const p = path.join(MODEL_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function ready() { return state.status === 'ready'; }
function status() { return { ...state, cachedPrompts: textCache.size }; }

/* ---------------- inference ---------------- */

function l2(vec) {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

/** 224x224 centre-cropped RGB float tensor, CLIP normalisation. */
async function pixels(jpegBuffer) {
  const { data } = await sharp(jpegBuffer)
    .resize(224, 224, { fit: 'cover', position: 'centre' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plane = 224 * 224;
  const t = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      t[c * plane + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  return t;
}

async function embedImage(jpegBuffer) {
  if (!ready()) await load();
  if (!ready()) throw new Error(state.error || 'CLIP unavailable');
  const t = await pixels(jpegBuffer);
  const out = await sessions.vision.run({
    pixel_values: new ort.Tensor('float32', t, [1, 3, 224, 224]),
  });
  return l2(out.image_embeds.data);
}

async function embedText(prompt) {
  if (!ready()) await load();
  if (!ready()) throw new Error(state.error || 'CLIP unavailable');
  const key = prompt.trim().toLowerCase();
  if (textCache.has(key)) return textCache.get(key);

  const ids = encodeText(prompt);
  const input = new BigInt64Array(CONTEXT).fill(BigInt(EOT));
  ids.forEach((id, i) => { input[i] = BigInt(id); });

  const out = await sessions.text.run({
    input_ids: new ort.Tensor('int64', input, [1, CONTEXT]),
  });
  const vec = l2(out.text_embeds.data);
  textCache.set(key, vec);
  saveTextCacheSoon();
  return vec;
}

/** Rank a crop against natural-language prompts. */
async function rank(jpegBuffer, prompts = [], { scale = 100, softmax = true } = {}) {
  const list = [...new Set(prompts.map((p) => String(p).trim()).filter(Boolean))];
  if (!list.length) return [];
  const img = await embedImage(jpegBuffer);
  const logits = [];
  for (const prompt of list) {
    const t = await embedText(prompt);
    let dot = 0;
    for (let i = 0; i < img.length; i++) dot += img[i] * t[i];
    logits.push({ label: prompt, logit: dot * scale });
  }
  if (softmax) {
    const max = Math.max(...logits.map((l) => l.logit));
    const exps = logits.map((l) => Math.exp(l.logit - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    logits.forEach((l, i) => { l.score = exps[i] / sum; });
  }
  return logits
    .map((l) => ({ label: l.label, score: +(l.score ?? 0).toFixed(4), logit: l.logit }))
    .sort((a, b) => b.logit - a.logit);
}

module.exports = { load, ready, status, rank, embedImage, embedText, encodeText, decodeText };
