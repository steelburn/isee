'use strict';
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const os = require('node:os');

const FFMPEG = require('ffmpeg-static');

const MAX_BACKOFF = 15000;
const STALL_MS = 15000;

function kindOf(source) {
  if (/^rtsp:\/\//i.test(source)) return 'rtsp';
  if (/^rtmp:\/\//i.test(source)) return 'rtmp';
  if (/^https?:\/\//i.test(source)) return 'http';
  if (/^[a-z]:[\\/]/i.test(source) || /^\/|^\.\//.test(source)) return 'file';
  return 'device';
}

/** Split a concatenated MJPEG byte stream into JPEG frames. */
class JpegSplitter {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    for (;;) {
      const start = this.buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (start === -1) {
        if (this.buf.length > 1) this.buf = this.buf.subarray(this.buf.length - 1);
        break;
      }
      const end = this.buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end === -1) {
        if (start > 0) this.buf = this.buf.subarray(start);
        if (this.buf.length > 16 * 1024 * 1024) this.buf = Buffer.alloc(0); // runaway guard
        break;
      }
      frames.push(this.buf.subarray(start, end + 2));
      this.buf = this.buf.subarray(end + 2);
    }
    return frames;
  }
}

class CameraSource extends EventEmitter {
  constructor(config) {
    super();
    this.config = config; // { id, name, kind, source, size, enabled }
    this.proc = null;
    this.splitter = new JpegSplitter();
    this.latest = null;
    this.latestAt = 0;
    this.frameCount = 0;
    this.fps = 0;
    this.retry = 0;
    this.status = 'stopped';
    this.message = '';
    this.wantRunning = false;
    this.fpsTimer = null;
    this.watchdog = null;
    this.restartTimer = null;
    this.lastFpsMark = { t: Date.now(), n: 0 };
    this._fpsSamples = [];
    this.frameTimes = [];
    this.sizeRejected = false;
  }

  setConfig(config) {
    const sourceChanged = config.source !== this.config.source
      || config.kind !== this.config.kind
      || config.size !== this.config.size;
    this.config = { ...this.config, ...config };
    if (sourceChanged) this.sizeRejected = false;
    if (sourceChanged && this.wantRunning) {
      // Windows keeps the device locked for a moment after SIGKILL
      this.stop();
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => { if (this.wantRunning) this.start(); }, 700);
    }
  }

  buildArgs() {
    const { kind, source, size } = this.config;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    const platform = os.platform();

    if (kind === 'webcam' || kind === 'device') {
      if (platform === 'win32') {
        args.push('-f', 'dshow', '-rtbufsize', '256M');
        if (size && !this.sizeRejected) args.push('-video_size', size);
        args.push('-i', `video=${source}`);
      } else if (platform === 'darwin') {
        args.push('-f', 'avfoundation', '-framerate', '30', '-i', `${source}:none`);
      } else {
        args.push('-f', 'v4l2', '-input_format', 'mjpeg');
        if (size && !this.sizeRejected) args.push('-video_size', size);
        args.push('-i', source);
      }
    } else if (kind === 'rtsp') {
      args.push('-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay', '-i', source);
    } else if (kind === 'rtmp' || kind === 'http') {
      args.push('-fflags', 'nobuffer', '-i', source);
    } else {
      args.push('-re', '-i', source);
    }

    args.push(
      '-an', '-sn',
      '-vf', `fps=15,scale='min(1920,iw)':-2`,
      '-q:v', '5',
      '-f', 'mjpeg',
      'pipe:1',
    );
    return args;
  }

  start() {
    if (this.proc) return;
    this.wantRunning = true;
    this.setStatus('starting', 'opening source');

    const args = this.buildArgs();
    let proc;
    try {
      proc = spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.setStatus('error', err.message);
      this.scheduleRestart();
      return;
    }
    this.proc = proc;
    this.splitter = new JpegSplitter();
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      for (const frame of this.splitter.push(chunk)) {
        this.latest = frame;
        this.latestAt = Date.now();
        this.frameCount++;
        this.frameTimes.push(this.latestAt);
        if (this.frameTimes.length > 120) this.frameTimes.shift();
        if (this.status !== 'live') {
          this.setStatus('live', '');
          if (this.retry) {
            // healthy again; decay the backoff
            this.retry = 0;
          }
        }
        this.emit('frame', frame);
      }
    });

    proc.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-1200);
    });

    proc.on('error', (err) => {
      stderr = err.message;
    });

    proc.on('exit', (code, signal) => {
      this.proc = null;
      if (!this.wantRunning) {
        this.setStatus('stopped', '');
        return;
      }
      const why = stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ') || `ffmpeg exited (${code ?? signal})`;
      // a requested resolution the device cannot deliver: fall back to its default once
      const sizeProblem = /video_size|dimensions|invalid|not supported|unsupported/i.test(why);
      if (this.config.size && sizeProblem && !this.sizeRejected) {
        this.sizeRejected = true;
        this.proc = null;
        this.setStatus('starting', `${this.config.size} unavailable — using the device default`);
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => { if (this.wantRunning) this.start(); }, 700);
        return;
      }
      this.setStatus('error', why.replace(/\s+/g, ' ').slice(0, 240));
      this.scheduleRestart();
    });

    this.startTimers();
  }

  startTimers() {
    clearInterval(this.fpsTimer);
    this.fpsTimer = setInterval(() => {
      const now = Date.now();
      // measured from actual frame arrivals, so a restart cannot zero it out
      const recent = this.frameTimes.filter((t) => now - t <= 3000);
      const span = recent.length > 1 ? (now - recent[0]) / 1000 : 0;
      this.fps = span > 0.5 ? +(recent.length / span).toFixed(1) : 0;
    }, 1500);

    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (!this.wantRunning || !this.proc) return;
      if (this.status === 'live' && Date.now() - this.latestAt > STALL_MS) {
        this.setStatus('error', 'stream stalled — restarting');
        this.kill();
        this.scheduleRestart();
      }
    }, 5000);
  }

  scheduleRestart() {
    clearTimeout(this.restartTimer);
    if (!this.wantRunning) return;
    this.retry = Math.min(this.retry + 1, 6);
    const delay = Math.min(MAX_BACKOFF, 1000 * 2 ** (this.retry - 1));
    this.restartTimer = setTimeout(() => {
      if (this.wantRunning) this.start();
    }, delay);
    this.emit('retry', delay);
  }

  kill() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    try { p.kill('SIGKILL'); } catch { /* already dead */ }
  }

  stop() {
    this.wantRunning = false;
    clearTimeout(this.restartTimer);
    clearInterval(this.fpsTimer);
    clearInterval(this.watchdog);
    this.kill();
    this.setStatus('stopped', '');
    this.fps = 0;
  }

  setStatus(status, message) {
    const changed = status !== this.status || message !== this.message;
    this.status = status;
    this.message = message;
    if (changed) this.emit('status', this.snapshot());
  }

  snapshot() {
    return {
      id: this.config.id,
      name: this.config.name,
      kind: this.config.kind,
      source: this.config.source,
      enabled: this.config.enabled,
      status: this.status,
      message: this.message,
      fps: this.fps,
      frameCount: this.frameCount,
      latestAt: this.latestAt,
      hasFrame: !!this.latest,
    };
  }
}

/** Enumerate local capture devices via ffmpeg / sysfs. */
function listDevices() {
  return new Promise((resolve) => {
    const platform = os.platform();
    if (platform === 'linux') {
      const out = [];
      try {
        for (const entry of require('node:fs').readdirSync('/sys/class/video4linux')) {
          let name = entry;
          try {
            name = require('node:fs').readFileSync(`/sys/class/video4linux/${entry}/name`, 'utf8').trim();
          } catch { /* keep index */ }
          out.push({ id: `/dev/${entry}`, name, kind: 'webcam' });
        }
      } catch { /* no v4l2 */ }
      return resolve(out);
    }

    execFile(
      FFMPEG,
      ['-hide_banner', '-list_devices', 'true', '-f', platform === 'darwin' ? 'avfoundation' : 'dshow', '-i', 'dummy'],
      { timeout: 12000, windowsHide: true },
      (err, stdout, stderr) => {
        const text = `${stdout}\n${stderr}`;
        const out = [];
        if (platform === 'darwin') {
          let section = '';
          for (const line of text.split('\n')) {
            if (/AVFoundation video devices/i.test(line)) { section = 'video'; continue; }
            if (/AVFoundation audio devices/i.test(line)) { section = 'audio'; continue; }
            if (section !== 'video') continue;
            const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
            if (m) out.push({ id: m[1], name: m[2], kind: 'webcam' });
          }
          return resolve(out);
        }
        for (const line of text.split('\n')) {
          const m = line.match(/"([^"]+)"\s*\((video|audio)\)/i);
          if (m && m[2].toLowerCase() === 'video') out.push({ id: m[1], name: m[1], kind: 'webcam' });
        }
        resolve(out);
      },
    );
  });
}

module.exports = { CameraSource, listDevices, kindOf, FFMPEG };
