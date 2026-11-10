'use strict';
const sharp = require('sharp');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Burn detection boxes and labels onto a JPEG so an MCP client (or a human)
 * sees exactly what the models claim, on the frame they claimed it about.
 */
async function annotate(jpegBuffer, analysis) {
  const meta = await sharp(jpegBuffer).metadata();
  const W = meta.width;
  const H = meta.height;
  const scale = W / Math.max(analysis.width || W, 1);
  const fs = Math.max(12, Math.round(W / 44));
  const pad = Math.round(fs * 0.42);

  const parts = [];
  const chip = (x, y, text, fill) => {
    const w = text.length * fs * 0.62;
    return `<rect x="${x}" y="${y}" width="${w + pad * 2}" height="${fs + pad * 1.6}" rx="${Math.round(fs * 0.18)}" fill="${fill}"/>` +
      `<text x="${x + pad}" y="${y + fs + pad * 0.55}" font-family="monospace" font-size="${fs}" fill="#ffffff">${esc(text)}</text>`;
  };

  for (const o of analysis.objects || []) {
    const [nx, ny, nw, nh] = o.box;
    const x = Math.round(nx * W), y = Math.round(ny * H);
    const w = Math.round(nw * W), h = Math.round(nh * H);
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#6FE3C0" stroke-width="${Math.max(2, Math.round(W / 480))}"/>`);
    parts.push(chip(x, Math.max(0, y - (fs + pad * 1.6)), `${o.label} ${o.score.toFixed(2)}`, '#12574B'));
  }

  for (const f of analysis.faces || []) {
    const [nx, ny, nw, nh] = f.box;
    const x = Math.round(nx * W), y = Math.round(ny * H);
    const w = Math.round(nw * W), h = Math.round(nh * H);
    const known = !!f.personId;
    const color = known ? '#12574B' : '#B32D22';
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${known ? '#8FE3CE' : '#FF8B7E'}" stroke-width="${Math.max(2, Math.round(W / 400))}"/>`);
    const label = known ? `${f.name} ${(f.similarity ?? 0).toFixed(2)}` : `unknown ${(f.similarity ?? 0).toFixed(2)}`;
    parts.push(chip(x, Math.max(0, y - (fs + pad * 1.6)), label, color));
  }

  if (!parts.length) return jpegBuffer;

  const svg = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`,
  );
  return sharp(jpegBuffer).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 85 }).toBuffer();
}

module.exports = { annotate };
