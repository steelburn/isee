#!/usr/bin/env node
/**
 * Local network camera discovery.
 *
 *   node tools/scan-network.js [options]
 *
 *   --cidr 192.168.88.0/24   subnet to sweep (default: this machine's /24)
 *   --iface Ethernet         pick a specific network interface
 *   --timeout 500            TCP connect timeout, ms
 *   --full                   scan all 65535 ports on camera-ish candidates
 *   --json report.json       write the machine-readable report
 *   --no-sweep               skip the TCP sweep (multicast probes only)
 *
 * Five probes, merged into one report:
 *
 *   1. ICMP + ARP  — every live host, including devices that answer ping and
 *                    nothing else. This is the only step that found the DVR in
 *                    the first real run: its RTSP port ignored a 350 ms connect
 *                    while ARP had it right there.
 *   2. ONVIF WS-Discovery — multicast to 239.255.255.250:3702, then a unicast
 *                    probe to each live host (many cameras ignore multicast).
 *                    Replies carry UUID, manufacturer/model scopes, XAddrs.
 *   3. mDNS        — _rtsp._tcp, _onvif._tcp, _nvr._tcp, _axis-video._tcp…
 *   4. TCP sweep   — camera ports across the subnet, doubling the timeout for
 *                    RTSP/media ports that routinely miss a short connect.
 *   5. Classify    — HTTP banner + title + WWW-Authenticate, OUI vendor lookup,
 *                    RTSP OPTIONS/DESCRIBE against the classic stream paths to
 *                    separate "open" from "auth required".
 *
 * Everything is read-only. No credential guessing: a device that answers 401 is
 * reported as reachable-but-locked, not probed further.
 */
'use strict';

const net = require('node:net');
const dgram = require('node:dgram');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// ---------------------------------------------------------------- arguments
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const flag = (name) => process.argv.includes('--' + name);

function localIPv4() {
  const forced = arg('iface', null);
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (forced && name !== forced) continue;
      if (/^169\.254\./.test(a.address)) continue;
      candidates.push({ iface: name, address: a.address, mac: a.mac });
    }
  }
  const routable = candidates.filter((c) => !/^172\.(1[6-9]|2\d|3[01])\./.test(c.address));
  const pick = (routable.length ? routable : candidates)[0];
  if (!pick) throw new Error('no routable IPv4 interface');
  return pick;
}

const self = localIPv4();
const cidr = arg('cidr', self.address.replace(/\.\d+$/, '.0') + '/24');
const BASE = cidr.split('/')[0].replace(/\.\d+$/, '.');
const TIMEOUT = Number(arg('timeout', 500));
const DO_SWEEP = !flag('no-sweep');

const CAMERA_PORTS = arg(
  'ports',
  [
    554, 8554, 555, 10554, // RTSP
    80, 81, 82, 83, 88, 8080, 8081, 8082, 8088, // embedded web UIs
    443, 8443, 8000, 8001, 8800, 8899, 8500, 9080,
    34567, 37777, 30100, // Dahua / XMeye private + NVR media
    2020, 5000, 5001, // Hikvision private / SDK
    1935, 5541, // RTMP / some NVRs
    9000, 7447, 3702, 6668, // Reolink media, Axis, ONVIF, Tuya
  ].map(Number),
);
const SLOW_PORTS = new Set([554, 8554, 555, 10554, 34567, 37777, 30100, 2020, 5000, 9000, 8554]);

// ------------------------------------------------------------------ helpers
const pad = (s, n) => String(s).padEnd(n);
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;
const clean = (s) => String(s).replace(/[^\x20-\x7e\r\n]/g, '.').replace(/\s+/g, ' ').trim();

function tcpProbe(host, port, timeout = TIMEOUT) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ host, port, open, ms: Date.now() - start });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/** Raw HTTP: embedded servers love a malformed status line ("HTTP/1.0 200 OK\r\n Content-type:"),
 *  which Node's client rejects with HPE_UNEXPECTED_SPACE. Speaking the protocol
 *  by hand is the difference between "no reply" and "here is the model name". */
function rawGet(host, port, path = '/', timeout = 2500) {
  return new Promise((resolve) => {
    const chunks = [];
    const socket = new net.Socket();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      socket.destroy();
      const buf = Buffer.concat(chunks);
      const text = buf.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      const head = text.slice(0, end < 0 ? 300 : end);
      const headers = {};
      for (const line of head.split('\r\n').slice(1)) {
        const m = line.match(/^\s*([\w-]+):\s*(.*)$/);
        if (m) headers[m[1].toLowerCase()] = m[2];
      }
      const status = Number((head.match(/(?:HTTP\/[\d.]+|RTSP\/[\d.]+)\s+(\d{3})/) || [])[1]) || null;
      resolve({
        host,
        port,
        path,
        status,
        headers,
        body: end < 0 ? Buffer.alloc(0) : buf.subarray(end + 4),
        text,
      });
    };
    socket.setTimeout(timeout);
    socket.on('timeout', finish);
    socket.on('error', finish);
    socket.on('close', finish);
    socket.on('connect', () =>
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUser-Agent: isee-scan/1\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
      ),
    );
    socket.on('data', (c) => {
      chunks.push(c);
      if (c.reduce) return;
      if (chunks.reduce((n, x) => n + x.length, 0) > 262144) finish();
    });
    socket.connect(port, host);
  });
}

/** RTSP OPTIONS then DESCRIBE — tells us whether a stream is open or locked. */
function rtsp(url, timeout = 2000) {
  const u = new URL(url);
  const host = u.hostname;
  const port = Number(u.port || 554);
  const path = u.pathname + u.search;
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buf = '';
    let done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ url, host, port, path, ...out });
    };
    const headersOf = (text) => {
      const out = {};
      for (const line of text.split('\r\n').slice(1)) {
        const m = line.match(/^\s*([\w-]+):\s*(.*)$/);
        if (m) out[m[1].toLowerCase()] = m[2];
      }
      return out;
    };
    socket.setTimeout(timeout);
    socket.on('timeout', () => finish({ status: null, headers: headersOf(buf) }));
    socket.on('error', (e) => finish({ status: null, error: e.code }));
    socket.on('close', () => finish({ status: null, headers: headersOf(buf) }));
    socket.on('connect', () =>
      socket.write(
        `DESCRIBE ${url} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: isee-scan\r\n\r\n`,
      ),
    );
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      const status = Number((buf.match(/^RTSP\/[\d.]+ (\d{3})/) || [])[1]);
      const headers = headersOf(buf);
      if (status === 200) {
        const sdp = buf.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        if (sdp.length > 20) return finish({ status, headers, sdp: sdp.slice(0, 4000) });
        // SDP arrives after the headers — give it a moment.
        return setTimeout(
          () => finish({ status, headers, sdp: buf.split('\r\n\r\n').slice(1).join('').slice(0, 4000) }),
          350,
        );
      }
      finish({ status, headers });
    });
    socket.connect(port, host);
  });
}

// ---------------------------------------------------- 1. ICMP sweep + ARP
const run = (cmd, args) =>
  new Promise((r) => execFile(cmd, args, { windowsHide: true, timeout: 4000 }, (e, o) => r(o || '')));

async function icmpSweep() {
  const n = 2 ** (32 - Number(cidr.split('/')[1] || 24)) - 2;
  const jobs = [];
  for (let i = 1; i <= Math.min(n, 1022); i++) {
    jobs.push(run('ping', process.platform === 'win32' ? ['-n', '1', '-w', '300', `${BASE}${i}`] : ['-c', '1', '-W', '1', `${BASE}${i}`]));
    if (jobs.length >= 128) await Promise.all(jobs.splice(0));
  }
  await Promise.all(jobs);
  const out = await run('arp', process.platform === 'win32' ? ['-a'] : ['-an']);
  const rows = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/(\d+\.\d+\.\d+\.\d+)\s+(?:.*?\s)?([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})/i);
    if (!m) continue;
    if (!m[1].startsWith(BASE) && cidr !== '0.0.0.0/0') continue;
    rows.set(m[1], { host: m[1], mac: m[2].toLowerCase().replace(/-/g, ':') });
  }
  return [...rows.values()].sort((a, b) => a.host.localeCompare(b.host, 'en', { numeric: true }));
}

// ------------------------------------------------------- 2. ONVIF WS-Discovery
function probeMessage(Types = 'dn:NetworkVideoTransmitter') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
            xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
            xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>uuid:${crypto.randomUUID()}</w:MessageID>
    <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body><d:Probe>${Types ? `<d:Types>${Types}</d:Types>` : ''}</d:Probe></e:Body>
</e:Envelope>`;
}

function parseDiscovery(text) {
  const pick = (tag) =>
    [...text.matchAll(new RegExp(`<[^>]*${tag}[^>]*>([\\s\\S]*?)</[^>]*${tag}>`, 'g'))]
      .map((m) => m[1].trim())
      .join(' ');
  return { scopes: pick('Scopes'), types: pick('Types'), xaddrs: pick('XAddrs') };
}

/** Multicast, then unicast to every live host — plenty of cameras answer only the latter. */
function wsDiscovery(liveHosts) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msg = probeMessage();
    const note = (address, text) => {
      const prev = found.get(address) || { host: address, replies: [] };
      prev.replies.push(parseDiscovery(text));
      found.set(address, prev);
    };
    sock.on('message', (m, rinfo) => note(rinfo.address, m.toString('utf8')));
    sock.on('error', () => {});
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
        sock.setMulticastTTL(2);
        sock.send(msg, 3702, '239.255.255.250');
        sock.send(msg, 3702, `${BASE}255`); // some stacks only answer broadcast
      } catch {}
      for (const h of liveHosts) {
        try {
          sock.send(msg, 3702, h);
        } catch {}
      }
    });
    setTimeout(() => {
      try {
        sock.close();
      } catch {}
      resolve([...found.values()].map((d) => ({
        host: d.host,
        scopes: d.replies.map((r) => r.scopes).filter(Boolean),
        types: d.replies.map((r) => r.types).filter(Boolean),
        xaddrs: d.replies.map((r) => r.xaddrs).filter(Boolean),
      })));
    }, 3000);
  });
}

// ------------------------------------------------------------------- 3. mDNS
const MDNS_SERVICES = [
  '_rtsp._tcp.local',
  '_rtsp._udp.local',
  '_onvif._tcp.local',
  '_axis-video._tcp.local',
  '_dahua._tcp.local',
  '_nvr._tcp.local',
  '_http._tcp.local',
  '_googlecast._tcp.local',
  '_hap._tcp.local',
];

function encodeQuery(name) {
  const labels = name
    .split('.')
    .filter(Boolean)
    .flatMap((p) => {
      const b = Buffer.from(p, 'utf8');
      return [Buffer.from([b.length]), b];
    });
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...labels,
    Buffer.from([0, 0, 12, 0, 1]),
  ]);
}

function decodeDns(buf) {
  const answers = [];
  try {
    let off = 12;
    const readName = (o) => {
      const parts = [];
      for (let guard = 0; guard < 64; guard++) {
        const len = buf[o];
        if (len === undefined || len === 0) return { name: parts.join('.'), next: o + 1 };
        if ((len & 0xc0) === 0xc0) {
          const sub = readName(((len & 0x3f) << 8) | buf[o + 1]);
          parts.push(sub.name);
          return { name: parts.join('.'), next: o + 2 };
        }
        parts.push(buf.toString('utf8', o + 1, o + 1 + len));
        o += len + 1;
      }
      return { name: parts.join('.'), next: o };
    };
    const [qd, an] = [buf.readUInt16BE(4), buf.readUInt16BE(6)];
    for (let i = 0; i < qd; i++) off = readName(off).next + 4;
    for (let i = 0; i < an && off + 10 <= buf.length; i++) {
      const n = readName(off);
      off = n.next;
      const type = buf.readUInt16BE(off);
      const rdlen = buf.readUInt16BE(off + 8);
      const rd = off + 10;
      let value = '';
      if (type === 12) value = readName(rd).name;
      else if (type === 33) value = clean(buf.toString('utf8', rd + 7, rd + rdlen));
      else if (type === 16) value = clean(buf.toString('utf8', rd, rd + Math.min(rdlen, 120)));
      else if (type === 1 && rdlen === 4) value = [...buf.subarray(rd, rd + 4)].join('.');
      else {
        off = rd + rdlen;
        continue;
      }
      answers.push({ name: n.name, type, value });
      off = rd + rdlen;
    }
  } catch {
    /* malformed packet */
  }
  return answers;
}

function mdns() {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (m, rinfo) => {
      const answers = decodeDns(m);
      if (!answers.length) return;
      const prev = found.get(rinfo.address) || { host: rinfo.address, answers: [] };
      prev.answers.push(...answers);
      found.set(rinfo.address, prev);
    });
    sock.on('error', () => {});
    sock.bind(0, () => {
      try {
        sock.setMulticastTTL(2);
        const send = () => MDNS_SERVICES.forEach((s) => sock.send(encodeQuery(s), 5353, '224.0.0.251'));
        send();
        setTimeout(send, 900); // mDNS is lossy
      } catch {}
    });
    setTimeout(() => {
      try {
        sock.close();
      } catch {}
      resolve([...found.values()]);
    }, 2600);
  });
}

// ------------------------------------------------------------------- 4. OUI
const OUI = {
  '00:12:42': 'Dahua', '9c:14:63': 'Dahua', '3c:e3:6b': 'Dahua', 'e0:50:8b': 'Dahua', 'a0:bd:1d': 'Dahua',
  '3c:ef:8c': 'Hikvision', 'bc:ad:28': 'Hikvision', 'c0:56:e3': 'Hikvision', '4c:bd:8f': 'Hikvision',
  '44:19:b6': 'Amcrest', '00:1a:07': 'Axis', 'ac:cc:8e': 'Axis', 'b8:a4:4f': 'Axis', '00:40:8c': 'Axis',
  'ec:71:db': 'Reolink', '60:7e:c6': 'Reolink', 'd4:9e:3f': 'Reolink',
  '00:0f:7c': 'Foscam', 'c4:d6:55': 'Foscam', '2c:aa:8e': 'Wyze', '7c:78:b2': 'Wyze',
  '44:47:cc': 'eZVIZ', '34:3e:a4': 'eZVIZ', 'ac:5f:3e': 'Hanwha', '00:09:18': 'Hanwha',
  '58:03:fb': 'Uniview', '48:ea:63': 'Uniview', '00:1c:27': 'Uniview', '00:0b:82': 'Grandstream',
  'c0:74:ad': 'Grandstream', 'b0:c5:54': 'D-Link', '34:08:04': 'D-Link',
  '60:01:94': 'Espressif', '24:0a:c4': 'Espressif', '84:f3:eb': 'Espressif', 'b8:69:f4': 'MikroTik',
  '48:8f:5a': 'MikroTik', '2c:c8:1b': 'MikroTik', 'e4:5f:01': 'Raspberry Pi', 'b8:27:eb': 'Raspberry Pi',
  'dc:a6:32': 'Raspberry Pi', 'bc:24:11': 'Proxmox VE', '00:15:5d': 'Hyper-V', '00:0c:29': 'VMware',
  '00:50:56': 'VMware', '18:c0:4d': 'Giga-byte', '84:47:09': 'AMD/Intel host',
};
const vendorOf = (mac) => OUI[(mac || '').slice(0, 8)] || '';

// --------------------------------------------------------------- 5. classify
const STREAM_PATHS = [
  '/',
  '/cam/realmonitor?channel=1&subtype=0', // Dahua
  '/cam/realmonitor?channel=1&subtype=1',
  '/Streaming/Channels/101', // Hikvision
  '/Streaming/Channels/102',
  '/stream1',
  '/live',
  '/h264',
  '/11',
  '/onvif1',
  '/axis-media/media.amp',
  '/stream',
];

const SERVER_HINTS = [
  [/netsurveillance|h264dvr|dvrdvs|xmeye/i, 'Dahua-family DVR/NVR'],
  [/hikvision|app-webs/i, 'Hikvision'],
  [/dahua|netsurveillance/i, 'Dahua'],
  [/axis/i, 'Axis'],
  [/reolink/i, 'Reolink'],
  [/amcrest/i, 'Amcrest'],
  [/tap[o0]/i, 'TP-Link Tapo'],
  [/foscam/i, 'Foscam'],
  [/vivotek/i, 'Vivotek'],
  [/uniview|unv/i, 'Uniview'],
  [/hanwha|wisenet/i, 'Hanwha'],
  [/go2rtc|mediamtx|rtsp-simple-server/i, 'software RTSP server'],
  [/routeros|mikrotik/i, 'MikroTik router'],
  [/luci|openwrt/i, 'OpenWrt router'],
  [/lighttpd|apache|nginx|uvicorn|gitea|openresty/i, 'web service'],
  [/cast|google/i, 'Google Cast device'],
];

function guessDevice(c) {
  const hay = [c.server, c.title, c.bodyHead, c.rtspServer, ...(c.scopes || [])].join(' ');
  for (const [re, name] of SERVER_HINTS) if (re.test(hay)) return name;
  if (c.streams && c.streams.some((s) => s.status)) return 'RTSP device';
  if (c.ports.includes(554) || c.ports.includes(8554)) return 'RTSP port open';
  return 'unknown';
}

const WEB_PORTS = [80, 81, 82, 83, 88, 443, 8080, 8081, 8082, 8088, 8000, 8443, 8800, 8899];
const CAMERA_SMELL = new Set([554, 8554, 555, 10554, 34567, 37777, 30100, 2020, 5000, 9000, 7447, 6668]);

async function classify(c) {
  const web = c.ports.find((p) => WEB_PORTS.includes(p));
  if (web) {
    const r = await rawGet(c.host, web, '/', 2000);
    c.webPort = web;
    c.server = r.headers.server || '';
    c.wwwAuth = r.headers['www-authenticate'] || '';
    c.title = (r.text.match(/<title[^>]*>([^<]{0,120})/i) || [])[1] || '';
    c.bodyHead = r.text.slice(0, 4000);
  }
  const rtspPort = c.ports.includes(554) ? 554 : c.ports.includes(8554) ? 8554 : null;
  if (rtspPort) {
    c.streams = [];
    for (const path of STREAM_PATHS) {
      const r = await rtsp(`rtsp://${c.host}:${rtspPort}${path}`);
      if (r.headers && r.headers.server && !c.rtspServer) c.rtspServer = r.headers.server;
      if (r.status) {
        c.streams.push({
          path,
          status: r.status,
          open: r.status === 200,
          auth: r.headers && r.headers['www-authenticate'],
          sdp: r.sdp ? r.sdp.slice(0, 600) : undefined,
        });
        if (c.streams.length >= 3) break;
      }
    }
  }
  c.guess = guessDevice(c);
  return c;
}

function cidrHosts(str) {
  const [base, bitsStr] = str.split('/');
  const bits = Number(bitsStr || 24);
  const baseNum = base.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  const size = 2 ** (32 - bits);
  const out = [];
  for (let n = baseNum + 1; n < baseNum + size - 1; n++) {
    out.push([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  return out;
}

async function sweep(hosts, ports, concurrency = 256) {
  const targets = [];
  for (const host of hosts) for (const port of ports) targets.push([host, port]);
  const hits = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < targets.length) {
        const [host, port] = targets[i++];
        const t = SLOW_PORTS.has(port) ? Math.max(TIMEOUT * 3, 1200) : TIMEOUT;
        const r = await tcpProbe(host, port, t);
        if (r.open) hits.push(r);
      }
    }),
  );
  return hits;
}

// --------------------------------------------------------------- main
(async function main() {
  const started = Date.now();
  const hosts = cidrHosts(cidr);
  console.log(bold('isee · network camera discovery'));
  console.log(dim(`  ${self.iface}  ${self.address}  mac ${self.mac}`));
  console.log('');

  process.stdout.write(dim('① ping sweep + ARP … '));
  const live = await icmpSweep();
  process.stdout.write(`\r${bold('① live hosts')} — ${live.length}${' '.repeat(12)}\n`);
  for (const h of live) {
    const v = vendorOf(h.mac);
    console.log(`   ${pad(h.host, 16)} ${h.mac}${v ? '  ' + dim(v) : ''}`);
  }

  const [ws, md] = await Promise.all([wsDiscovery(live.map((h) => h.host)), mdns()]);

  console.log('');
  console.log(bold('② ONVIF WS-Discovery'));
  if (!ws.length) console.log(dim('   nothing answered multicast or unicast'));
  for (const d of ws) {
    const scopes = [...new Set(d.scopes.flatMap((s) => s.split(/\s+/)).filter(Boolean))];
    const grab = (k) => (scopes.find((s) => s.includes('/' + k + '/')) || '').split('/').pop();
    console.log(`   ${ok(d.host)}  ${[grab('name'), grab('hardware'), grab('location')].filter(Boolean).join(' · ')}`);
    if (d.xaddrs.length) console.log(dim(`            ${d.xaddrs.join(' ')}`));
  }

  console.log('');
  console.log(bold('③ mDNS'));
  const advertised = md.filter((m) => m.answers.some((a) => /rtsp|onvif|nvr|dahua|axis|video/i.test(a.name + a.value)));
  if (!advertised.length) console.log(dim('   no camera services advertised'));
  for (const m of advertised) {
    console.log(`   ${ok(m.host)}`);
    for (const a of [...new Set(m.answers.map((x) => `${x.name}=${x.value}`))].slice(0, 5)) {
      console.log(dim(`            ${a}`));
    }
  }

  let hits = [];
  if (DO_SWEEP) {
    process.stdout.write(dim('④ TCP sweep … '));
    hits = await sweep(hosts, CAMERA_PORTS);
    process.stdout.write(
      `\r${bold('④ open ports')} — ${hits.length} on ${new Set(hits.map((h) => h.host)).size} host(s)${' '.repeat(10)}\n`,
    );
  }

  // merge everything into per-host records
  const byHost = new Map();
  const touch = (host) => {
    if (!byHost.has(host)) byHost.set(host, { host, ports: [], mac: '', scopes: [], sources: new Set() });
    return byHost.get(host);
  };
  for (const h of hits) {
    if (h.host === self.address) continue;
    const rec = touch(h.host);
    rec.ports.push(h.port);
    rec.sources.add('tcp');
  }
  for (const w of ws) {
    const rec = touch(w.host);
    rec.scopes.push(...w.scopes);
    rec.sources.add('onvif');
  }
  for (const h of live) {
    if (!byHost.has(h.host)) continue;
    byHost.get(h.host).mac = h.mac;
  }

  const cameraish = [...byHost.values()]
    .filter((c) => c.scopes.length || c.ports.some((p) => CAMERA_SMELL.has(p)))
    .sort((a, b) => a.host.localeCompare(b.host, 'en', { numeric: true }));

  if (flag('full')) {
    // one more pass, all 65535 ports, only on hosts that already look like cameras
    for (const c of cameraish) {
      process.stdout.write(dim(`   full scan ${c.host} … `));
      let next = 1;
      const extra = [];
      await Promise.all(
        Array.from({ length: 400 }, async () => {
          while (next <= 65535) {
            const p = next++;
            if (c.ports.includes(p)) continue;
            if ((await tcpProbe(c.host, p, 250)).open) extra.push(p);
          }
        }),
      );
      c.ports.push(...extra);
      process.stdout.write(`${extra.length} more port(s)\n`);
    }
  }

  console.log('');
  console.log(bold(`⑤ Camera candidates — ${cameraish.length}`));
  if (!cameraish.length) {
    console.log(dim('   none. No ONVIF reply, no RTSP port, no DVR private port on any live host.'));
  }
  for (const c of cameraish) {
    c.ports = [...new Set(c.ports)].sort((a, b) => a - b);
    await classify(c);
    const open = (c.streams || []).filter((s) => s.open);
    console.log('');
    console.log(
      `   ${bold(c.host)}  ${c.guess !== 'unknown' ? ok(c.guess) : dim('unidentified')}` +
        (c.sources.size > 1 ? dim('  [' + [...c.sources].join('+') + ']') : ''),
    );
    console.log(dim('     ports  ') + c.ports.join(' '));
    if (c.mac) console.log(dim('     mac    ') + c.mac + (vendorOf(c.mac) ? `  (${vendorOf(c.mac)})` : ''));
    if (c.server) console.log(dim('     server ') + c.server);
    if (c.title) console.log(dim('     title  ') + clean(c.title));
    if (c.wwwAuth) console.log(dim('     auth   ') + clean(c.wwwAuth).slice(0, 90));
    if (c.rtspServer) console.log(dim('     rtsp   ') + c.rtspServer);
    for (const s of c.streams || []) {
      const tag = s.open ? ok('OPEN ') : s.auth ? warn('AUTH ') : dim(`${s.status}   `);
      console.log(`     ${tag} rtsp://${c.host}:${c.ports.includes(8554) && !c.ports.includes(554) ? 8554 : 554}${s.path}`);
      if (s.auth && !s.open) console.log(dim('            ' + clean(s.auth).slice(0, 100)));
      if (s.sdp) {
        const codec = (s.sdp.match(/a=rtpmap:\d+ (\S+)/) || [])[1];
        const size = (s.sdp.match(/a=framesize:\d+ (\S+)/) || [])[1];
        console.log(dim(`            sdp ${[codec, size].filter(Boolean).join(' · ')}`));
      }
    }
    if (c.scopes.length) {
      const flat = [...new Set(c.scopes.flatMap((s) => s.split(/\s+/)))].filter((s) => /onvif|name|hardware|location/.test(s));
      for (const s of flat.slice(0, 4)) console.log(dim('     onvif  ') + s);
    }
    c.reachable = open.length > 0;
    c.locked = !open.length;
  }

  const report = {
    scannedAt: new Date().toISOString(),
    interface: self,
    cidr,
    elapsedMs: Date.now() - started,
    live,
    wsDiscovery: ws,
    mdns: md.filter((m) => m.answers.length),
    openPorts: hits,
    candidates: cameraish.map(({ bodyHead, scopes, ...rest }) => ({ ...rest, scopes })),
  };
  const out = arg('json', null);
  if (out) {
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log('');
    console.log(dim(`report → ${out}`));
  }

  const openable = cameraish.filter((c) => (c.streams || []).some((s) => s.open)).length;
  console.log('');
  console.log(
    dim(
      `${Date.now() - started} ms · ${cameraish.length} candidate(s) · ${openable} with an open stream · ${cameraish.length - openable} locked behind authentication`,
    ),
  );
})().catch((e) => {
  console.error('scan failed:', e.message);
  process.exit(1);
});
