'use strict';
/**
 * LAN camera discovery for the console's add-camera panel.
 *
 * Deliberately the cheap version of tools/scan-network.js: no ICMP sweep (ARP
 * already knows every device that has spoken recently, and the ones that have
 * not are not cameras you are about to add), a fixed camera-port list, and HTTP
 * titles only on hosts that answered a web port. A full subnet scan second only
 * matters for a device that answers nothing, which by definition cannot be
 * added here.
 *
 *   TCP sweep   camera ports across the /24, longer wait on RTSP + DVR ports
 *   WS-Discovery multicast + unicast to whoever answered
 *   ARP table   vendor per MAC, so a row can say "Dahua" instead of nothing
 *   HTTP title  so a row can say "NETSurveillance WEB"
 *
 * Cached for two minutes — an operator re-opening the dialog should not re-scan.
 */
const net = require('node:net');
const dgram = require('node:dgram');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const CACHE_MS = 120_000;

const PORTS = [
  { port: 554, slow: true, camera: true },
  { port: 8554, slow: true, camera: true },
  { port: 34567, slow: true, camera: true },
  { port: 37777, slow: true, camera: true },
  { port: 2020, slow: true, camera: true },
  { port: 9000, slow: true, camera: true },
  { port: 80, web: true },
  { port: 8080, web: true },
  { port: 8000, web: true },
  { port: 81, web: true },
  { port: 8081, web: true },
  { port: 443, web: true },
];

const OUI = {
  '00:12:42': 'Dahua', '9c:14:63': 'Dahua', '3c:e3:6b': 'Dahua', 'e0:50:8b': 'Dahua',
  '3c:ef:8c': 'Hikvision', 'bc:ad:28': 'Hikvision', 'c0:56:e3': 'Hikvision', '4c:bd:8f': 'Hikvision',
  '44:19:b6': 'Amcrest', '00:1a:07': 'Axis', 'ac:cc:8e': 'Axis', 'b8:a4:4f': 'Axis',
  'ec:71:db': 'Reolink', '60:7e:c6': 'Reolink', 'd4:9e:3f': 'Reolink',
  '00:0f:7c': 'Foscam', 'c4:d6:55': 'Foscam', '2c:aa:8e': 'Wyze', '7c:78:b2': 'Wyze',
  '44:47:cc': 'eZVIZ', '34:3e:a4': 'eZVIZ', '58:03:fb': 'Uniview', '48:ea:63': 'Uniview',
  '00:0b:82': 'Grandstream', 'c0:74:ad': 'Grandstream', 'b0:c5:54': 'D-Link',
  '60:01:94': 'Espressif', 'b8:69:f4': 'MikroTik', '48:8f:5a': 'MikroTik',
  'bc:24:11': 'Proxmox VM', '00:15:5d': 'Hyper-V', '00:0c:29': 'VMware', '00:50:56': 'VMware',
  'e4:5f:01': 'Raspberry Pi', 'b8:27:eb': 'Raspberry Pi', 'dc:a6:32': 'Raspberry Pi',
};

const vendorOf = (mac = '') => OUI[mac.slice(0, 8)] || '';

let cache = { at: 0, value: null };

function localIPv4() {
  const all = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || /^169\.254\./.test(a.address)) continue;
      all.push({ address: a.address, mac: a.mac });
    }
  }
  const routable = all.filter((a) => !/^172\.(1[6-9]|2\d|3[01])\./.test(a.address));
  return (routable[0] || all[0]) || { address: '127.0.0.1', mac: '' };
}

function tcpProbe(host, port, timeout) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function httpTitle(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const secure = port === 443;
    const mod = secure ? require('node:https') : http;
    let settled = false;
    let body = '';
    const parse = () => ({
      title: ((body.match(/<title[^>]*>([^<]{0,80})/i) || [])[1] || '').trim(),
      server: '',
      auth: '',
      status: 0,
      ...parsed.headers,
    });
    const parsed = { headers: {} };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = mod.request(
      { host, port, path: '/', method: 'GET', timeout, rejectUnauthorized: false, agent: false,
        headers: { 'User-Agent': 'isee-discover', Accept: 'text/html,*/*', Connection: 'close' } },
      (res) => {
        parsed.headers = {
          status: res.statusCode,
          server: res.headers.server || '',
          auth: res.headers['www-authenticate'] || '',
        };
        res.setEncoding('latin1');
        res.on('data', (c) => {
          body += c;
          // A title lives in the first few KB; stop reading the rest of the page.
          if (body.length > 20000) {
            try { req.destroy(); } catch {}
            finish(parse());
          }
        });
        res.on('end', () => finish(parse()));
        res.on('error', () => finish(body ? parse() : null));
      },
    );
    // A TLS socket that never completes its handshake holds the event loop open
    // even after req.destroy(), so the socket is destroyed explicitly.
    const kill = () => {
      try { if (req.socket) req.socket.destroy(); } catch {}
      try { req.destroy(); } catch {}
      finish(body ? parse() : null);
    };
    req.on('timeout', kill);
    req.on('error', () => finish(body ? parse() : null));
    req.on('close', () => { if (!settled) finish(body ? parse() : null); });
    req.end();
  });
}

function arpTable(base) {
  return new Promise((resolve) => {
    execFile('arp', [os.platform() === 'win32' ? '-a' : '-an'], { windowsHide: true, timeout: 4000 }, (err, out) => {
      const rows = new Map();
      for (const line of String(out || '').split(/\r?\n/)) {
        const m = line.match(/(\d+\.\d+\.\d+\.\d+)\s+(?:.*?\s)?([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})/i);
        if (!m || !m[1].startsWith(base + '.')) continue;
        rows.set(m[1], m[2].toLowerCase().replace(/-/g, ':'));
      }
      resolve(rows);
    });
  });
}

function wsDiscovery(hosts) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msg = `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
 xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
<e:Header><w:MessageID>uuid:${crypto.randomUUID()}</w:MessageID>
<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>
<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;

    sock.on('message', (m, rinfo) => {
      const text = m.toString('utf8');
      const scopes = [...text.matchAll(/<[^>]*Scopes[^>]*>([\s\S]*?)<\/[^>]*Scopes>/g)]
        .map((x) => x[1]).join(' ').split(/\s+/).filter(Boolean);
      const name = (scopes.find((s) => /\/name\//.test(s)) || '').split('/').pop();
      const hardware = (scopes.find((s) => /\/hardware\//.test(s)) || '').split('/').pop();
      found.set(rinfo.address, { onvif: true, onvifName: name || '', onvifModel: hardware || '', scopes });
    });
    sock.on('error', () => {});
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
        sock.setMulticastTTL(2);
        sock.send(msg, 3702, '239.255.255.250');
        for (const h of hosts) sock.send(msg, 3702, h);
      } catch { /* multicast unavailable */ }
    });
    setTimeout(() => {
      try { sock.close(); } catch {}
      resolve(found);
    }, 2200);
  });
}

function hostRange(base) {
  const out = [];
  for (let i = 1; i <= 254; i++) out.push(`${base}.${i}`);
  return out;
}

function guess({ ports, title, server, onvifModel, onvifName, vendor }) {
  const hay = [title, server, onvifModel, onvifName].join(' ');
  if (/netsurveillance|h264dvr|xmeye|dvrdvs/i.test(hay)) return { label: 'XM DVR', preset: 'xmeye' };
  if (/hikvision|app-webs/i.test(hay)) return { label: 'Hikvision', preset: 'hikvision' };
  if (/dahua/i.test(hay) || vendor === 'Dahua') return { label: 'Dahua DVR', preset: 'dahua' };
  if (/reolink/i.test(hay)) return { label: 'Reolink', preset: 'onvif' };
  if (/axis/i.test(hay)) return { label: 'Axis', preset: 'onvif' };
  if (/amcrest/i.test(hay)) return { label: 'Amcrest', preset: 'onvif' };
  if (/foscam|uniview|hanwha|vivotek/i.test(hay)) return { label: 'IP camera', preset: 'onvif' };
  if (ports.includes(34567) || ports.includes(37777)) return { label: 'DVR', preset: 'dahua' };
  if (ports.includes(554) || ports.includes(8554)) return { label: 'RTSP device', preset: 'onvif' };
  if (/printer|hp inc|epson|brother/i.test(hay)) return { label: 'printer', preset: 'onvif', notCamera: true };
  if (vendor) return { label: vendor, preset: 'onvif', notCamera: true };
  return { label: 'device', preset: 'onvif', notCamera: true };
}

async function scan() {
  const started = Date.now();
  const self = localIPv4();
  const base = self.address.split('.').slice(0, 3).join('.');
  const hosts = hostRange(base);

  // ARP first: it is instant and it tells us which rows to expect.
  const arp = await arpTable(base);

  const open = new Map();
  let cursor = 0;
  const targets = [];
  for (const host of hosts) for (const p of PORTS) targets.push([host, p.port]);

  await Promise.all(
    Array.from({ length: 380 }, async () => {
      while (cursor < targets.length) {
        const [host, port] = targets[cursor++];
        const spec = PORTS.find((p) => p.port === port);
        const timeout = spec && spec.slow ? 700 : 220;
        if (await tcpProbe(host, port, timeout)) {
          if (!open.has(host)) open.set(host, []);
          open.get(host).push(port);
        }
      }
    }),
  );

  const live = [...open.keys()];
  const [onvif, titles] = await Promise.all([
    wsDiscovery(live),
    // Belt and braces: the titles are a nicety, never something a dialog waits on.
    Promise.race([
      Promise.all(live.map(async (host) => {
        const web = open.get(host).find((p) => [80, 81, 443, 8000, 8080, 8081].includes(p));
        if (!web) return [host, null];
        return [host, await httpTitle(host, web)];
      })),
      new Promise((r) => setTimeout(() => r(live.map((h) => [h, null])), 2500)),
    ]),
  ]);
  const web = new Map(titles.filter(([, t]) => t));

  const rows = live.filter((h) => h !== self.address).map((host) => {
    const ports = open.get(host).sort((a, b) => a - b);
    const meta = web.get(host) || {};
    const ws = onvif.get(host) || {};
    const mac = arp.get(host) || '';
    const vendor = vendorOf(mac);
    const g = guess({ ports, title: meta.title, server: meta.server, onvifModel: ws.onvifModel, onvifName: ws.onvifName, vendor });
    const rtspPort = ports.includes(554) ? 554 : ports.includes(8554) ? 8554 : null;
    return {
      host,
      mac,
      vendor,
      ports,
      title: meta.title || ws.onvifName || '',
      server: meta.server || ws.onvifModel || '',
      rtspPort,
      kind: g.label,
      preset: g.preset,
      camera: !g.notCamera && Boolean(rtspPort || ws.onvif || ports.includes(34567) || ports.includes(37777)),
      auth: Boolean(meta.auth) || Boolean(rtspPort),
    };
  })
    // cameras first, then everything else so the list still explains the network
    .sort((a, b) => (b.camera - a.camera) || a.host.localeCompare(b.host, 'en', { numeric: true }));

  return {
    scannedAt: Date.now(),
    interface: self,
    subnet: `${base}.0/24`,
    ms: Date.now() - started,
    hosts: rows,
    cameras: rows.filter((r) => r.camera).length,
  };
}

async function discover({ force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.value, cached: true };
  }
  // A discovery endpoint must answer. Twelve seconds is the outer bound; the
  // scan itself normally finishes in three or four.
  const value = await Promise.race([
    scan(),
    new Promise((resolve) => setTimeout(() => resolve({
      scannedAt: Date.now(),
      interface: localIPv4(),
      subnet: `${localIPv4().address.split('.').slice(0, 3).join('.')}.0/24`,
      ms: 12000,
      hosts: [],
      cameras: 0,
      timedOut: true,
    }), 12000)),
  ]);
  cache = { at: Date.now(), value };
  return { ...value, cached: false };
}

module.exports = { discover, vendorOf };
