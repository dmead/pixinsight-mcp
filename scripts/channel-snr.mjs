// channel-snr.mjs — per-channel SNR of LINEAR masters, with noise measured on
// BACKGROUND ONLY, over the whole frame or a centred crop.
//
//   node scripts/channel-snr.mjs [--crop 1.0,0.5,0.25,0.12] [--bg both|full|crop] \
//        <master.xisf> [<master.xisf> ...]
//
// Whole-image MAD is NOT the noise of a nebula target: extended emission is
// counted as scatter, so the channel with the most signal reports the most
// "noise" and the worst SNR. (Measured that way, the Tulip's Ha -- the channel
// the object is brightest in -- looked 3x noisier than S2.) The same trap cost
// the M82 superlum its weighting.
//
// Instead: tile the frame, take the darkest tiles by median as background, and
// estimate sigma from those tiles only. Signal is then measured against that
// background in units of that sigma.
//
// CROPPING HAS ITS OWN TRAP, which is why --bg exists. The dark-tile background
// is only meaningful while the frame still contains real sky. Crop down onto the
// object and the darkest remaining tiles are nebula, so bg rises and every SNR
// drops -- hardest for the channel the surrounding field is brightest in. That
// is a shift of the baseline, not a loss of signal, and it masks the thing you
// actually wanted to see (the percentile moving into brighter material). So:
//   bg=full  background held at the crop=1.0 value -> ratios comparable across
//            crops. THIS IS THE HEADLINE NUMBER.
//   bg=crop  background re-measured inside the crop -> what you get if you
//            naively crop and re-measure. Confounds the two effects.
// Rows where the two disagree by more than 3 sigma are flagged '*': there the
// crop no longer contains separable sky.
import fs from 'fs';
import path from 'path';

function readPlane(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.toString('latin1', 0, 8) !== 'XISF0100') throw new Error('not monolithic XISF');
    const xmlLen = head.readUInt32LE(8);
    const xmlBuf = Buffer.alloc(xmlLen);
    fs.readSync(fd, xmlBuf, 0, xmlLen, 16);
    const xml = xmlBuf.toString('utf8');
    const img = xml.match(/<Image\b[^>]*>/);
    if (!img) throw new Error('no Image element');
    const geom = img[0].match(/geometry="(\d+):(\d+):(\d+)"/);
    const fmt = (img[0].match(/sampleFormat="(\w+)"/) || [, 'Float32'])[1];
    const loc = img[0].match(/location="attachment:(\d+):(\d+)"/);
    if (!geom || !loc) throw new Error('unsupported Image element');
    const [w, h] = [Number(geom[1]), Number(geom[2])];
    const bytes = { Float32: 4, Float64: 8, UInt16: 2, UInt8: 1, UInt32: 4 }[fmt];
    if (!bytes) throw new Error(`unhandled sampleFormat ${fmt}`);

    // Plate scale, so lit area can be reported in sq arcmin rather than in
    // tiles. XPIXSZ already reflects the drizzle scale on a drizzled master.
    const kw = (n) => {
      const m = xml.match(new RegExp(`<FITSKeyword name="${n}" value="([^"]*)"`));
      return m ? Number(m[1].replace(/'/g, '').trim()) : null;
    };
    const xpixsz = kw('XPIXSZ'), focallen = kw('FOCALLEN');
    const scale = xpixsz && focallen ? 206.265 * xpixsz / focallen : null; // arcsec/px

    const px = new Float32Array(w * h);
    const CHUNK = 1 << 22;
    const buf = Buffer.alloc(CHUNK);
    let pos = Number(loc[1]), remaining = w * h * bytes, k = 0;
    while (remaining > 0) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, remaining), pos);
      if (n <= 0) break;
      pos += n; remaining -= n;
      const count = Math.floor(n / bytes);
      for (let i = 0; i < count && k < px.length; ++i) {
        px[k++] = fmt === 'Float32' ? buf.readFloatLE(i * bytes)
          : fmt === 'Float64' ? buf.readDoubleLE(i * bytes)
          : fmt === 'UInt16' ? buf.readUInt16LE(i * bytes) / 65535
          : fmt === 'UInt32' ? buf.readUInt32LE(i * bytes) / 4294967295
          : buf.readUInt8(i * bytes) / 255;
      }
    }
    return { w, h, px, scale };
  } finally { fs.closeSync(fd); }
}

const medianOf = (a) => { const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };
function madnOf(a, med) {
  const d = new Float64Array(a.length);
  for (let i = 0; i < a.length; ++i) d[i] = Math.abs(a[i] - med);
  d.sort();
  return 1.4826 * d[d.length >> 1];
}

// Tile medians (and MADNs) over an axis-aligned box, at tile size T.
// `center` splits the leftover remainder evenly so that concentric crops share a
// concentric tile grid. Without it the grid is anchored at box.x0 and shifts as
// the crop changes, so the same patch of sky straddles tile edges differently at
// each crop and the lit-area figures jitter by +/-1 tile between rows.
function tileBox(px, w, box, T, center) {
  const out = [];
  let { x0, y0 } = box;
  if (center) {
    x0 += Math.floor(((box.x1 - box.x0) % T) / 2);
    y0 += Math.floor(((box.y1 - box.y0) % T) / 2);
  }
  for (let ty = y0; ty + T <= box.y1; ty += T) {
    for (let tx = x0; tx + T <= box.x1; tx += T) {
      const buf = new Float64Array(T * T);
      let i = 0;
      for (let y = ty; y < ty + T; ++y)
        for (let x = tx; x < tx + T; ++x) buf[i++] = px[y * w + x];
      const med = medianOf(buf);
      out.push({ med, madn: madnOf(buf, med) });
    }
  }
  return out;
}

// Centred crop box at linear fraction `frac`, with an optional inset margin.
// The 5% margin dodges vignetting and stacking edges and is only meaningful on
// the full frame; a centred sub-crop is already clear of them.
function cropBox(w, h, frac, margin) {
  const cw = Math.floor(w * frac), ch = Math.floor(h * frac);
  let x0 = Math.floor((w - cw) / 2), y0 = Math.floor((h - ch) / 2);
  let x1 = x0 + cw, y1 = y0 + ch;
  if (margin > 0) {
    x0 = Math.floor(w * margin); x1 = Math.floor(w * (1 - margin));
    y0 = Math.floor(h * margin); y1 = Math.floor(h * (1 - margin));
  }
  return { x0, y0, x1, y1 };
}

const clamp = (lo, v, hi) => Math.max(lo, Math.min(v, hi));
const BRIGHT_T = 128; // fixed tile size for bright%, so crops stay comparable

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
let crops = [1.0], bgMode = 'both';
const files = [];
for (let i = 0; i < argv.length; ++i) {
  if (argv[i] === '--crop') crops = argv[++i].split(',').map(Number);
  else if (argv[i] === '--bg') bgMode = argv[++i];
  else files.push(argv[i]);
}
if (!files.length) {
  console.error('usage: channel-snr.mjs [--crop 1.0,0.5,...] [--bg both|full|crop] <master.xisf>...');
  process.exit(2);
}
crops.sort((a, b) => b - a);
if (crops[0] !== 1.0) crops.unshift(1.0); // bg=full needs the full-frame anchor

const rows = [];
for (const f of files) {
  let d;
  try { d = readPlane(f); } catch (e) { console.error(`  ${path.basename(f)}  !! ${e.message}`); continue; }
  const { w, h, px, scale } = d;
  const name = path.basename(f)
    .replace(/^masterLight_BIN-1_\d+x\d+_/, '')
    .replace(/_mono.*$/, '')
    .replace(/EXPOSURE-[\d.]+s_FILTER-/, '');

  let full = null; // crop=1.0 anchor, for bg=full
  for (const frac of crops) {
    const isFull = frac === 1.0;
    const box = cropBox(w, h, frac, isFull ? 0.05 : 0);
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0;

    // Tile size scales with the crop so the tile count stays near ~1600; a
    // fixed 128 would leave a 12% crop with 25 tiles and a 2-tile dark decile.
    const T = clamp(32, Math.floor(bw / 40), 128);
    const tiles = tileBox(px, w, box, T);
    if (!tiles.length) { console.error(`  ${name} @${frac}  !! no tiles`); continue; }
    tiles.sort((a, b) => a.med - b.med);
    const dark = tiles.slice(0, Math.max(1, Math.floor(tiles.length * 0.10)));
    const bgCrop = medianOf(dark.map((t) => t.med));
    const sigma = medianOf(dark.map((t) => t.madn));

    if (isFull) full = { bg: bgCrop, sigma };
    const bgFull = full.bg;

    // Percentiles over the pixels inside the box.
    const n = bw * bh;
    const sorted = new Float32Array(n);
    let k = 0;
    for (let y = box.y0; y < box.y1; ++y)
      for (let x = box.x0; x < box.x1; ++x) sorted[k++] = px[y * w + x];
    sorted.sort();
    const pct = (p) => sorted[Math.floor(p * (sorted.length - 1))];
    const snr = (p, bg) => (pct(p) - bg) / sigma;

    // frac>5sig is a pixel fraction (no granularity problem); bright% is the
    // fraction of FIXED-SIZE tiles whose median clears the threshold, i.e. how
    // much of the field is lit by extended emission rather than by stars.
    const thr = bgFull + 5 * sigma;
    let above = 0;
    for (let i = sorted.length - 1; i >= 0 && sorted[i] > thr; --i) ++above;
    const bTiles = tileBox(px, w, box, BRIGHT_T, true);
    const nBright = bTiles.filter((t) => t.med > thr).length;
    // Below ~25 tiles the grid is coarser than the structure it is measuring
    // (a 6% crop leaves 2x2, i.e. 25% granularity, which renders as a spurious
    // "100.0%"). Report nothing rather than a number that invites misreading;
    // frac>5sig is the per-pixel metric and stays valid at any crop.
    const coarse = bTiles.length < 25;
    const brightFrac = coarse || !bTiles.length ? null : nBright / bTiles.length;
    const litArea = coarse || !scale ? null : nBright * Math.pow(BRIGHT_T * scale / 60, 2); // sq arcmin

    rows.push({
      name, frac, bw, bh, T, sigma, bgFull, bgCrop, scale,
      p95F: snr(0.95, bgFull), p95C: snr(0.95, bgCrop),
      p99F: snr(0.99, bgFull), p99C: snr(0.99, bgCrop),
      above: 100 * above / sorted.length,
      brightFrac: brightFrac == null ? null : 100 * brightFrac, litArea,
      flag: bgCrop - bgFull > 3 * sigma,
    });
  }
}

// --- report -----------------------------------------------------------------
const s0 = rows.find((r) => r.scale);
if (s0) {
  const fov = (n) => (n * s0.scale / 60).toFixed(1);
  // s0 is the crop=1.0 row, whose box is already inset by the 5% margin -- so
  // label it as the measured box, not as the frame.
  console.log(`\nplate scale ${s0.scale.toFixed(3)}"/px   crop=1.0 measured box ${s0.bw}x${s0.bh} = ` +
    `${fov(s0.bw)}' x ${fov(s0.bh)}'   (5% margin, applied at crop=1.0 only)`);
}
const showF = bgMode === 'both' || bgMode === 'full';
const showC = bgMode === 'both' || bgMode === 'crop';
console.log('\n  filter      crop   box(px)    tile   sigma      bg(full)   bg(crop)  ' +
  `${showF ? '  p99F   p95F' : ''}${showC ? '   p99C   p95C' : ''}   frac>5s  bright%   lit sq'`);
for (const r of rows) {
  console.log(
    `  ${r.name.padEnd(10)}${(100 * r.frac).toFixed(0).padStart(4)}%${`${r.bw}x${r.bh}`.padStart(11)}` +
    `${String(r.T).padStart(6)}  ${r.sigma.toExponential(2).padEnd(10)} ${r.bgFull.toExponential(2).padEnd(10)} ` +
    `${r.bgCrop.toExponential(2)}${r.flag ? '*' : ' '}` +
    `${showF ? `${r.p99F.toFixed(0).padStart(7)}${r.p95F.toFixed(1).padStart(7)}` : ''}` +
    `${showC ? `${r.p99C.toFixed(0).padStart(7)}${r.p95C.toFixed(1).padStart(7)}` : ''}` +
    `${r.above.toFixed(2).padStart(9)}%` +
    `${r.brightFrac == null ? '     n/a ' : `${r.brightFrac.toFixed(1).padStart(8)}%`}` +
    `${r.litArea == null ? '      n/a' : r.litArea.toFixed(1).padStart(9)}`);
}

// Channel ratios vs crop, Ha normalised to 1.00 -- the actual question.
const byCrop = new Map();
for (const r of rows) {
  if (!byCrop.has(r.frac)) byCrop.set(r.frac, []);
  byCrop.get(r.frac).push(r);
}
const ha = (g) => g.find((r) => /halpha|^ha$/i.test(r.name));
if ([...byCrop.values()].some((g) => ha(g) && g.length > 1)) {
  console.log('\n  p95 SNR ratios at bg=full (halpha = 1.00) -- how the channels rebalance as you crop');
  console.log('  crop     ' + [...new Set(rows.map((r) => r.name))].map((n) => n.padStart(10)).join(''));
  for (const [frac, g] of [...byCrop.entries()].sort((a, b) => b[0] - a[0])) {
    const base = ha(g);
    if (!base) continue;
    console.log(`  ${(100 * frac).toFixed(0).padStart(4)}%    ` +
      [...new Set(rows.map((r) => r.name))].map((n) => {
        const r = g.find((x) => x.name === n);
        return (r ? (r.p95F / base.p95F).toFixed(2) : '-').padStart(10);
      }).join(''));
  }
}
