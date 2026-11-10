'use strict';
/**
 * OCR accuracy bench.
 *
 * Compares both engines against known strings in the frame and reports exact
 * match and character error rate. Use it whenever you change preprocessing —
 * three "obvious" improvements measured worse and were reverted because of it.
 *
 *   npm run bench:ocr
 *   node tools/ocr-bench.js --image frame.jpg --repeats 5
 *
 * The regions are pixel boxes on a 1920x1080 capture of the reference scene.
 * If the camera moves, re-aim the box (and the truth string) before trusting
 * the numbers.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const understand = require(path.join(ROOT, 'src/detect/understand'));
const ppocr = require(path.join(ROOT, 'src/detect/ppocr'));

const CASES = [
  { name: 'SEOKO', truth: 'SEOKO', box: { left: 600, top: 282, width: 110, height: 34 } },
  // the leading "3 " is behind the operator's arm in the reference frame, so the
  // visible string is what we measure against — box and truth must agree
  { name: 'TIER STORAGE CABINET', truth: 'TIER STORAGE CABINET', box: { left: 1000, top: 680, width: 460, height: 130 } },
];

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const IMAGE = argOf('image', null);
const REPEATS = Number(argOf('repeats', 3));

const tight = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
const spaced = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

const cer = (got, truth) => {
  const g = tight(got);
  const t = tight(truth);
  return t.length ? levenshtein(g, t) / t.length : (g ? 1 : 0);
};

async function captureFrame() {
  if (IMAGE) return fs.readFileSync(IMAGE);
  const res = await fetch('http://127.0.0.1:7373/api/cameras');
  const cams = await res.json();
  if (!cams.length) throw new Error('no cameras configured');
  const frame = await fetch(`http://127.0.0.1:7373/api/cameras/${cams[0].id}/frame.jpg`);
  const buf = Buffer.from(await frame.arrayBuffer());
  const saved = path.join(ROOT, '.tmp', 'bench-frame.jpg');
  fs.mkdirSync(path.dirname(saved), { recursive: true });
  fs.writeFileSync(saved, buf);
  console.log(`captured -> ${saved}  (re-run with --image ${saved} for a fixed frame)`);
  return buf;
}

(async () => {
  await understand.warm();
  const frame = await captureFrame();
  const meta = await sharp(frame).metadata();
  console.log(`frame ${meta.width}x${meta.height} · ${REPEATS} run(s) per cell\n`);

  const rows = [];
  for (const c of CASES) {
    const crop = await sharp(frame).extract(c.box).jpeg({ quality: 95 }).toBuffer();
    for (const engine of ['tesseract', 'ppocr']) {
      const results = [];
      for (let i = 0; i < REPEATS; i++) {
        const t = Date.now();
        const out = engine === 'ppocr'
          ? await ppocr.readText(crop)
          : await understand.readTesseract(crop);
        results.push({ out, ms: Date.now() - t });
      }
      const best = results.reduce((a, b) => ((b.out?.confidence || 0) > (a.out?.confidence || 0) ? b : a));
      const cers = results.map((r) => (r.out ? cer(r.out.text, c.truth) : 1));
      const mean = cers.reduce((x, y) => x + y, 0) / cers.length;
      const exactSpaced = results.filter((r) => r.out && spaced(r.out.text) === spaced(c.truth)).length;
      rows.push({
        string: c.name,
        engine,
        text: best.out ? best.out.text.replace(/\n/g, ' | ') : '(nothing)',
        conf: best.out ? best.out.confidence : 0,
        cer: mean,
        exact: cers.filter((x) => x === 0).length,
        exactSpaced,
        ms: Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length),
      });
    }
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('string', 24), pad('engine', 11), pad('conf', 6), pad('CER', 6), pad('chars', 7), pad('spacing', 9), pad('ms', 5), 'text');
  console.log('-'.repeat(112));
  for (const r of rows) {
    console.log(
      pad(r.string, 24),
      pad(r.engine, 11),
      pad(`${r.conf}%`, 6),
      pad(`${(r.cer * 100).toFixed(0)}%`, 6),
      pad(`${r.exact}/${REPEATS}`, 7),
      pad(`${r.exactSpaced}/${REPEATS}`, 9),
      pad(r.ms, 5),
      JSON.stringify(r.text).slice(0, 42),
    );
  }
  console.log('\nCER ignores case and punctuation, so it measures the characters.');
  console.log('"chars" is that exact; "spacing" also requires word boundaries.\n');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
