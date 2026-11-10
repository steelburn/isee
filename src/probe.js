'use strict';
/**
 * Stream probing — "does this address actually give me a picture?"
 *
 * The console cannot ask an operator to commit to a URL it has never seen a
 * frame from. This module builds the candidate URLs for a given device family
 * and asks ffmpeg for one frame from each, in order, stopping at the first
 * that answers.
 *
 * Two rules matter here:
 *   - A 401 stops the walk. The credentials are wrong for every path, and
 *     every extra attempt spends one of the five tries most DVRs give you
 *     before they freeze the account.
 *   - A probe never touches the pipeline. It is its own short-lived ffmpeg,
 *     so a wrong address cannot disturb a working camera.
 */
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const FFMPEG = require('ffmpeg-static');

const FRAME_TIMEOUT = 6000; // one path
const BUDGET = 15000; // the whole probe, all candidates
const MAX_ATTEMPTS = 4;

const PRESETS = {
  auto: 'Detect automatically',
  dahua: 'Dahua / NVR',
  xmeye: 'XMeye / NETSurveillance DVR',
  hikvision: 'Hikvision',
  onvif: 'ONVIF / generic RTSP',
  http: 'MJPEG over HTTP',
  custom: 'Full URL',
};

const enc = (s) => encodeURIComponent(String(s ?? ''));

/** The literal source string that will be stored on the camera. */
function buildSource(spec = {}) {
  const preset = spec.preset || 'auto';
  const host = String(spec.host || '').trim();
  const port = Number(spec.port) || (preset === 'http' ? 80 : 554);
  const user = spec.user || '';
  const pass = spec.password || '';
  const channel = Math.max(1, Number(spec.channel) || 1);
  const quality = spec.quality === '0' || spec.quality === 0 ? 0 : 1;
  const auth = user ? `${enc(user)}:${enc(pass)}@` : '';

  switch (preset) {
    case 'custom':
      return String(spec.source || '').trim();
    case 'http':
      return String(spec.source || '').trim() || `http://${host}:${port}/video`;
    case 'hikvision':
      return `rtsp://${auth}${host}:${port}/Streaming/Channels/${channel}0${quality === 0 ? '1' : '2'}`;
    case 'xmeye':
      // legacy firmware carries credentials in the path, not in userinfo
      return `rtsp://${host}:${port}/user=${enc(user)}&password=${enc(pass)}&channel=${channel}&stream=${quality === 0 ? 0 : 1}.sdp?`;
    case 'dahua':
      return `rtsp://${auth}${host}:${port}/cam/realmonitor?channel=${channel}&subtype=${quality === 0 ? 0 : 1}`;
    case 'onvif':
      return `rtsp://${auth}${host}:${port}/`;
    default:
      return `rtsp://${auth}${host}:${port}/cam/realmonitor?channel=${channel}&subtype=${quality === 0 ? 0 : 1}`;
  }
}

/** Every URL worth trying for this spec, cheapest-to-confirm first. */
function buildCandidates(spec = {}) {
  const base = buildSource(spec);
  const preset = spec.preset || 'auto';
  if (!base) return [];

  if (preset !== 'auto' && preset !== 'onvif') return [base];

  // auto / onvif: walk the path shapes the industry actually uses
  const host = String(spec.host || '').trim();
  const port = Number(spec.port) || 554;
  const user = spec.user || '';
  const pass = spec.password || '';
  const channel = Math.max(1, Number(spec.channel) || 1);
  const quality = spec.quality === '0' || spec.quality === 0 ? 0 : 1;
  const auth = user ? `${enc(user)}:${enc(pass)}@` : '';
  const p = (path) => `rtsp://${auth}${host}:${port}${path}`;

  const walk = [
    p(`/cam/realmonitor?channel=${channel}&subtype=${quality === 0 ? 0 : 1}`), // Dahua / XM
    p(`/Streaming/Channels/${channel}0${quality === 0 ? '1' : '2'}`), // Hikvision
    `rtsp://${host}:${port}/user=${enc(user)}&password=${enc(pass)}&channel=${channel}&stream=${quality === 0 ? 0 : 1}.sdp?`, // XMeye
    p('/stream1'),
    p('/live'),
    p('/'),
    p('/onvif1'),
    p('/axis-media/media.amp'),
  ];
  return [...new Set(walk)].slice(0, MAX_ATTEMPTS + 4);
}

function mask(source = '') {
  return String(source)
    .replace(/\/\/([^:/@]+):([^@]*)@/, (m, u, p) => `//${u}:${p ? '••••' : ''}@`)
    .replace(/(password=)([^&\s]+)/i, (m, k) => `${k}••••`);
}

function grab(source, timeout = FRAME_TIMEOUT) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (/^rtsp:/i.test(source)) args.push('-rtsp_transport', 'tcp');
    args.push('-rw_timeout', '5000000', '-i', source);
    args.push('-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '6', '-f', 'mjpeg', 'pipe:1');

    let child;
    try {
      child = spawn(FFMPEG, args, { windowsHide: true });
    } catch (err) {
      return resolve({ status: 'error', message: err.message, ms: 0 });
    }

    const out = [];
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      resolve({ status: 'timeout', message: 'No answer within 6 s.', ms: Date.now() - started });
    }, timeout);

    child.stdout.on('data', (c) => {
      out.push(c);
      if (out.reduce((n, x) => n + x.length, 0) > 4_000_000) { try { child.kill(); } catch {} }
    });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); if (stderr.length > 6000) stderr = stderr.slice(-3000); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: 'error', message: err.message, ms: Date.now() - started });
    });

    child.on('close', async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      const jpeg = buf.length > 512 && buf[0] === 0xff && buf[1] === 0xd8;

      if (jpeg) {
        let width = 0;
        let height = 0;
        try {
          const meta = await sharp(buf).metadata();
          width = meta.width;
          height = meta.height;
        } catch { /* keep 0 */ }
        return resolve({ status: 'open', jpeg: buf, width, height, ms: Date.now() - started, stderr });
      }
      resolve({ status: classify(stderr), message: humanise(stderr), ms: Date.now() - started, stderr });
    });
  });
}

function classify(stderr = '') {
  if (/401|unauthorized|authorization failed|authenticat/i.test(stderr)) return 'auth';
  if (/404|not found|invalid url|no such/i.test(stderr)) return 'notfound';
  if (/connection refused|no route|failed to connect|network is unreachable|i\/o error/i.test(stderr)) return 'unreachable';
  if (/timed out|timeout|operation timed out/i.test(stderr)) return 'timeout';
  if (/protocol not found|unknown format|invalid data/i.test(stderr)) return 'unsupported';
  return 'error';
}

const HUMAN = {
  auth: 'The camera refused the credentials (401).',
  notfound: 'Connected, but that path is not a stream.',
  unreachable: 'Nothing accepted the connection on that port.',
  timeout: 'Connected — the device stopped answering. Usually the address is right and the path is not.',
  unsupported: 'The address answered, but not with video this can read.',
  error: 'ffmpeg could not open that address.',
};

function humanise(stderr = '') {
  const status = classify(stderr);
  const hint = HUMAN[status] || HUMAN.error;
  // After a 401 the hint is the whole story — repeating ffmpeg's own line adds
  // noise, and the operator's next move is the label on the box, not a trace.
  if (status === 'auth') return hint;
  const line = stderr.split(/\r?\n/).filter(Boolean).pop() || '';
  return line ? `${hint} ${line.replace(/^\[[^\]]+\]\s*/, '').slice(0, 160)}` : hint;
}

/**
 * Try candidates until one yields a frame.
 * Returns the winning source (real + masked), the frame as a data URL, and
 * what each attempt said — so the UI can report "credentials rejected" as
 * different from "wrong address".
 */
async function probe(spec = {}) {
  const candidates = buildCandidates(spec);
  if (!candidates.length) return { ok: false, status: 'invalid', message: 'Enter an address first.', attempts: [] };

  const started = Date.now();
  const attempts = [];

  for (const source of candidates) {
    if (Date.now() - started > BUDGET) {
      attempts.push({ source: mask(source), status: 'skipped', message: 'Probe budget used up.' });
      break;
    }
    const r = await grab(source);
    attempts.push({ source: mask(source), status: r.status, message: r.message || '' });

    if (r.status === 'open') {
      return {
        ok: true,
        status: 'open',
        source,
        masked: mask(source),
        preview: `data:image/jpeg;base64,${r.jpeg.toString('base64')}`,
        width: r.width,
        height: r.height,
        ms: Date.now() - started,
        attempts,
      };
    }
    // Right address, wrong password: no other path will do better, and every
    // retry spends one of the device's five attempts.
    if (r.status === 'auth') break;
  }

  const last = attempts[attempts.length - 1] || {};
  return {
    ok: false,
    status: last.status || 'error',
    message: last.message || 'No frame.',
    attempts,
    ms: Date.now() - started,
    masked: mask(candidates[0]),
  };
}

module.exports = { probe, buildSource, buildCandidates, mask, PRESETS };
