// Hand-rolled placeholder icon (no deps): a small dark square with three
// connected nodes, echoing the graph/diagram motif. Swap media/icon.png
// with real artwork whenever you have one — this just unblocks packaging.
import zlib from 'zlib';
import fs from 'fs';

const SIZE = 128;
const BG = [0x1e, 0x1e, 0x1e];
const BORDER = [0x56, 0x9c, 0xd6];
const EDGE = [0x6a, 0x6a, 0x6a];
const NODE_FILL = [0x2a, 0x3a, 0x38];
const NODE_STROKE = [0x4e, 0xc9, 0xb0];

const px = new Uint8Array(SIZE * SIZE * 4);
function setPixel(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) { return; }
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}
function blend(x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) { return; }
  const i = (y * SIZE + x) * 4;
  const a = alpha / 255;
  px[i] = px[i] * (1 - a) + color[0] * a;
  px[i + 1] = px[i + 1] * (1 - a) + color[1] * a;
  px[i + 2] = px[i + 2] * (1 - a) + color[2] * a;
  px[i + 3] = 255;
}
function fillRoundedRect(x0, y0, x1, y1, r, color) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x < x0 + r ? x0 + r - x : x > x1 - r ? x - (x1 - r) : 0;
      const dy = y < y0 + r ? y0 + r - y : y > y1 - r ? y - (y1 - r) : 0;
      if (dx * dx + dy * dy <= r * r || (dx === 0 || dy === 0)) { setPixel(x, y, color); }
    }
  }
}
function strokeLine(x0, y0, x1, y1, color, width = 3) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    for (let ox = -width / 2; ox <= width / 2; ox++) {
      for (let oy = -width / 2; oy <= width / 2; oy++) {
        blend(Math.round(x + ox), Math.round(y + oy), color, 220);
      }
    }
  }
}
function fillCircle(cx, cy, r, fill, stroke, strokeW = 4) {
  for (let y = cy - r - strokeW; y <= cy + r + strokeW; y++) {
    for (let x = cx - r - strokeW; x <= cx + r + strokeW; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) { blend(x, y, fill, 255); }
      else if (d <= r + strokeW) { blend(x, y, stroke, 255); }
    }
  }
}

// background + border (rounded square)
fillRoundedRect(0, 0, SIZE, SIZE, 22, BG);
for (let i = 0; i < 4; i++) {
  for (let x = 14 + i; x < SIZE - 14 - i; x++) { blend(x, 14 + i, BORDER, 60); blend(x, SIZE - 15 - i, BORDER, 60); }
  for (let y = 14 + i; y < SIZE - 14 - i; y++) { blend(14 + i, y, BORDER, 60); blend(SIZE - 15 - i, y, BORDER, 60); }
}

// three nodes + edges (the graph motif)
const A = [40, 46], B = [90, 40], C = [64, 92];
strokeLine(...A, ...B, EDGE);
strokeLine(...A, ...C, EDGE);
strokeLine(...B, ...C, EDGE);
fillCircle(...A, 13, NODE_FILL, NODE_STROKE);
fillCircle(...B, 10, NODE_FILL, NODE_STROKE);
fillCircle(...C, 16, NODE_FILL, NODE_STROKE);

// ---- minimal PNG encoder (RGBA8, no external deps) ----
function crc32(buf) {
  let c, table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
      t[n] = c;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) { crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA, no interlace

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const idat = zlib.deflateSync(raw);
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync('media/icon.png', png);
console.log('wrote media/icon.png', png.length, 'bytes');
