// xisf-preview.mjs — render auto-STF PNG previews straight from XISF files,
// without PixInsight.
//
//   node scripts/xisf-preview.mjs <out-dir> <label>=<path> [<label>=<path> ...]
//
// Exists because headless PixInsight launches on this box intermittently
// no-op (start, exit 0, run nothing), which makes PJSR-based preview
// generation unreliable. The masters are uncompressed Float32 XISF with the
// pixel block at a byte offset given in the header, so reading them directly
// is straightforward and needs no dependencies.
//
// Applies the standard STF autostretch — shadows clipped at -2.8 sigma
// (MAD-based), midtones mapped so the background lands at 0.25 — computed
// independently per image, which is what a screen transfer function does.
//
// PNG output is a VIEWING artifact. Measurements belong on the XISF.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const DOWNSAMPLE = 10;
const ROWS_AVERAGED = 2;      // rows averaged per output row (cheap SNR gain)
const TARGET_BG = 0.25;
const SHADOW_CLIP = -2.80;

// ---- XISF header ----------------------------------------------------------
function readXisfHeader(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  if (head.toString('latin1', 0, 8) !== 'XISF0100')
    throw new Error('not an XISF monolithic file');
  const xmlLength = head.readUInt32LE(8);
  const xml = Buffer.alloc(xmlLength);
  fs.readSync(fd, xml, 0, xmlLength, 16);
  return xml.toString('utf8');
}

function parseImage(xml) {
  // First <Image ...> element carries geometry, sample format and location.
  const m = xml.match(/<Image\b[^>]*>/);
  if (!m) throw new Error('no <Image> element');
  const tag = m[0];
  const attr = (n) => {
    const a = tag.match(new RegExp(`${n}="([^"]+)"`));
    return a ? a[1] : null;
  };
  const geometry = attr('geometry');
  const sampleFormat = attr('sampleFormat');
  const location = attr('location');
  if (!geometry || !location) throw new Error('missing geometry/location');
  const [w, h, c] = geometry.split(':').map(Number);
  const loc = location.split(':');
  if (loc[0] !== 'attachment')
    throw new Error(`unsupported location "${location}" (only uncompressed attachments)`);
  if (sampleFormat !== 'Float32')
    throw new Error(`unsupported sampleFormat ${sampleFormat}`);
  return { width: w, height: h, channels: c, offset: Number(loc[1]), size: Number(loc[2]) };
}

// ---- read + downsample (block average on LINEAR data) ---------------------
function downsample(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const img = parseImage(readXisfHeader(fd));
    const F = DOWNSAMPLE;
    const outW = Math.floor(img.width / F);
    const outH = Math.floor(img.height / F);
    const out = new Float64Array(outW * outH);
    const rowBytes = img.width * 4;
    const row = Buffer.alloc(rowBytes);

    for (let j = 0; j < outH; ++j) {
      const acc = new Float64Array(outW);
      let used = 0;
      for (let r = 0; r < ROWS_AVERAGED; ++r) {
        const srcRow = j * F + r;
        if (srcRow >= img.height) break;
        fs.readSync(fd, row, 0, rowBytes, img.offset + srcRow * rowBytes);
        for (let i = 0; i < outW; ++i) {
          let s = 0;
          for (let k = 0; k < F; ++k) s += row.readFloatLE((i * F + k) * 4);
          acc[i] += s / F;
        }
        used++;
      }
      for (let i = 0; i < outW; ++i) out[j * outW + i] = acc[i] / (used || 1);
    }
    return { width: outW, height: outH, data: out };
  } finally {
    fs.closeSync(fd);
  }
}

// ---- auto-STF -------------------------------------------------------------
const mtf = (m, x) => (x <= 0 ? 0 : x >= 1 ? 1 : ((m - 1) * x) / (((2 * m - 1) * x) - m));

function autoStretch(img) {
  const v = Float64Array.from(img.data).sort();
  const median = v[Math.floor(v.length / 2)];
  const dev = Float64Array.from(img.data, (x) => Math.abs(x - median)).sort();
  const mad = dev[Math.floor(dev.length / 2)] * 1.4826;

  let c0 = median + SHADOW_CLIP * mad;
  if (!(c0 > 0)) c0 = 0;
  if (c0 >= 1) c0 = 0;
  const m = mtf(TARGET_BG, median - c0);

  const px = new Uint8Array(img.width * img.height);
  for (let i = 0; i < img.data.length; ++i) {
    const x = (img.data[i] - c0) / (1 - c0);
    px[i] = Math.max(0, Math.min(255, Math.round(mtf(m, x) * 255)));
  }
  return { px, median, mad, c0, m };
}

// ---- minimal 8-bit greyscale PNG -----------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; ++n) {
    let c = n;
    for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; ++i) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function writePng(file, width, height, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 0;    // greyscale
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; ++y) {
    raw[y * (width + 1)] = 0;   // filter: none
    Buffer.from(px.buffer, px.byteOffset + y * width, width)
      .copy(raw, y * (width + 1) + 1);
  }
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ---- main -----------------------------------------------------------------
const [outDir, ...specs] = process.argv.slice(2);
if (!outDir || specs.length === 0) {
  console.error('usage: xisf-preview.mjs <out-dir> <label>=<path> ...');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

for (const spec of specs) {
  const eq = spec.indexOf('=');
  const label = spec.slice(0, eq);
  const file = spec.slice(eq + 1);
  try {
    const img = downsample(file);
    const st = autoStretch(img);
    const out = path.join(outDir, `${label}.png`);
    writePng(out, img.width, img.height, st.px);
    console.log(`${label.padEnd(18)} ${img.width}x${img.height}  median=${st.median.toFixed(6)}` +
      `  MAD=${st.mad.toExponential(2)}  c0=${st.c0.toFixed(6)}  m=${st.m.toFixed(4)}  -> ${out}`);
  } catch (e) {
    console.error(`${label.padEnd(18)} FAILED: ${e.message}`);
  }
}
