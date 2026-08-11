// xisf-gridcheck.mjs — test a master's background for PERIODIC structure
// (drizzle coverage grid, tile seams) without PixInsight.
//
//   node scripts/xisf-gridcheck.mjs <label>=<path> [...]
//
// Method: take a wide background strip, reduce it to row and column profiles
// using the MEDIAN along each line (robust to stars), detrend with a moving
// average to kill the large-scale gradient, then autocorrelate the residual.
//
// Periodic structure shows as a peak at its period:
//   - a 2x drizzle coverage grid   -> strong signal at lag 2 (and 4, 6, ...)
//   - SXT / network tile seams     -> a peak at the tile pitch (128/256/512)
// A clean background autocorrelates to ~0 at every lag beyond the PSF width.

import fs from 'fs';

// Background strip: wide, above the galaxies. Medians make it robust to stars.
const X0 = 200, X1 = 5800, Y0 = 200, Y1 = 2600;
const DETREND_WIN = 129;      // moving-average window (odd)
const MAX_LAG = 768;
const KEY_LAGS = [2, 3, 4, 6, 8, 16, 32, 64, 128, 192, 256, 384, 512];

function readXisfHeader(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  if (head.toString('latin1', 0, 8) !== 'XISF0100') throw new Error('not monolithic XISF');
  const xml = Buffer.alloc(head.readUInt32LE(8));
  fs.readSync(fd, xml, 0, xml.length, 16);
  return xml.toString('utf8');
}
function parseImage(xml) {
  const tag = xml.match(/<Image\b[^>]*>/)[0];
  const at = (n) => (tag.match(new RegExp(`${n}="([^"]+)"`)) || [])[1];
  const [w, h] = at('geometry').split(':').map(Number);
  const loc = at('location').split(':');
  if (at('sampleFormat') !== 'Float32') throw new Error('expected Float32');
  return { width: w, height: h, offset: Number(loc[1]) };
}

const median = (a) => { const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };

function detrend(p) {
  const n = p.length, half = DETREND_WIN >> 1, out = new Float64Array(n);
  for (let i = 0; i < n; ++i) {
    let s = 0, c = 0;
    for (let k = -half; k <= half; ++k) {
      const j = i + k;
      if (j >= 0 && j < n) { s += p[j]; c++; }
    }
    out[i] = p[i] - s / c;
  }
  return out;
}

function autocorr(r, maxLag) {
  const n = r.length;
  let mean = 0;
  for (let i = 0; i < n; ++i) mean += r[i];
  mean /= n;
  let v0 = 0;
  for (let i = 0; i < n; ++i) v0 += (r[i] - mean) ** 2;
  const ac = new Float64Array(maxLag + 1);
  for (let L = 0; L <= maxLag; ++L) {
    let s = 0;
    for (let i = 0; i + L < n; ++i) s += (r[i] - mean) * (r[i + L] - mean);
    ac[L] = v0 > 0 ? s / v0 : 0;
  }
  return ac;
}

function analyse(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const img = parseImage(readXisfHeader(fd));
    const w = Math.min(X1, img.width), h = Math.min(Y1, img.height);
    const nx = w - X0, ny = h - Y0;
    const rowBytes = img.width * 4;
    const buf = Buffer.alloc(rowBytes);

    const rowProf = new Float64Array(ny);          // median along each row
    const cols = Array.from({ length: nx }, () => new Float64Array(ny));

    const line = new Float64Array(nx);
    for (let j = 0; j < ny; ++j) {
      fs.readSync(fd, buf, 0, rowBytes, img.offset + (Y0 + j) * rowBytes);
      for (let i = 0; i < nx; ++i) line[i] = buf.readFloatLE((X0 + i) * 4);
      rowProf[j] = median(line);
      for (let i = 0; i < nx; ++i) cols[i][j] = line[i];
    }
    const colProf = new Float64Array(nx);
    for (let i = 0; i < nx; ++i) colProf[i] = median(cols[i]);

    const bg = median(rowProf);
    const result = {};
    for (const [name, prof] of [['rows(Y)', rowProf], ['cols(X)', colProf]]) {
      const res = detrend(prof);
      let rms = 0;
      for (let i = 0; i < res.length; ++i) rms += res[i] ** 2;
      rms = Math.sqrt(rms / res.length);
      const ac = autocorr(res, Math.min(MAX_LAG, res.length >> 2));
      // strongest peak beyond the PSF correlation length
      let peak = { lag: 0, r: 0 };
      for (let L = 12; L < ac.length; ++L)
        if (Math.abs(ac[L]) > Math.abs(peak.r)) peak = { lag: L, r: ac[L] };
      result[name] = { rms, rmsPct: (rms / bg) * 100, ac, peak };
    }
    return { bg, nx, ny, result };
  } finally {
    fs.closeSync(fd);
  }
}

for (const spec of process.argv.slice(2)) {
  const eq = spec.indexOf('=');
  const label = spec.slice(0, eq), file = spec.slice(eq + 1);
  try {
    const a = analyse(file);
    console.log(`\n=== ${label} ===  strip ${a.nx}x${a.ny}  background median ${a.bg.toFixed(6)}`);
    for (const axis of ['rows(Y)', 'cols(X)']) {
      const r = a.result[axis];
      console.log(`  ${axis}  detrended RMS = ${r.rms.toExponential(2)} (${r.rmsPct.toFixed(3)}% of background)`);
      console.log(`      strongest peak (lag>=12): lag ${r.peak.lag} r=${r.peak.r.toFixed(4)}`);
      console.log('      r at key lags: ' +
        KEY_LAGS.filter((L) => L < r.ac.length)
          .map((L) => `${L}:${r.ac[L].toFixed(3)}`).join('  '));
    }
  } catch (e) {
    console.error(`${label}: FAILED ${e.message}`);
  }
}
