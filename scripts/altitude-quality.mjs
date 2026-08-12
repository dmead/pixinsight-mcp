// altitude-quality.mjs — where does sub quality actually fall off with altitude?
//
//   node scripts/altitude-quality.mjs --from-master <master.xisf> \
//        --report D:/Temp/sh2101-select/selection-report.csv \
//        --lights Z:/sh2101-restack/lights [--bin 10]
//
// TIMESTAMPS: the filename stamp is LOCAL time, not UTC -- DATE-OBS in the
// header runs exactly 4 hours ahead of it during EDT. Reading the filename as
// UTC puts every frame 4 hours early and lands a dozen of them below the
// horizon. So the true time comes from each sub's DATE-OBS keyword; hardcoding
// a UTC offset instead would silently break across the DST boundary.
//
// Answers "what altitude cutoff should I use?" from measured subs rather than
// from the usual rule of thumb. Joins a select-subs selection report (fwhmPx,
// eccentricity, starCount, bgPerSec, psfSignalWeight) to the target altitude at
// mid-exposure, computed from the frame timestamp and the site coordinates in
// the master.
//
// Metrics are expressed RELATIVE TO EACH FILTER'S OWN MEDIAN before binning.
// Absolute background rate differs by almost an order of magnitude between Ha
// and O3, and FWHM differs by filter too, so pooling raw values would just
// measure the filter mix within each altitude bin.
import fs from 'fs';
import { jd2000, altitude, masterKeywords } from './lib/astro.mjs';

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i < 0 ? d : a[i + 1]; };
const { ra, dec, lat, lon, object } = masterKeywords(opt('--from-master'));
const binSize = Number(opt('--bin', 10));
const rows = fs.readFileSync(opt('--report'), 'utf8').split(/\r?\n/).filter(Boolean);
const head = rows[0].split(',');
const col = (n) => head.indexOf(n);

// Higher is better for starCount and psfSignalWeight; lower is better for the rest.
const METRICS = [
  { key: 'fwhmPx', label: 'FWHM', better: 'lower' },
  { key: 'eccentricity', label: 'ecc', better: 'lower' },
  { key: 'bgPerSec', label: 'sky bg', better: 'lower' },
  { key: 'starCount', label: 'stars', better: 'higher' },
  { key: 'psfSignalWeight', label: 'PSF signal', better: 'higher' },
];

// Map each report row to the pooled sub, so DATE-OBS can be read from it.
const lightsDir = opt('--lights');
const pool = new Map();
if (lightsDir)
  for (const f of fs.readdirSync(lightsDir)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
    if (m && !pool.has(m[1])) pool.set(m[1], `${lightsDir}/${f}`);
  }

function dateObs(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const xml = Buffer.alloc(head.readUInt32LE(8));
    fs.readSync(fd, xml, 0, xml.length, 16);
    const m = xml.toString('utf8').match(/<FITSKeyword name="DATE-OBS" value="'?([^"']+)/);
    return m ? new Date(`${m[1].trim()}Z`) : null;
  } catch { return null; } finally { fs.closeSync(fd); }
}

const subs = [];
let missing = 0;
for (const line of rows.slice(1)) {
  const f = line.split(',');
  const stamp = (f[0].match(/^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/) || [])[1];
  if (!stamp) continue;
  const path = pool.get(stamp);
  const t0 = path ? dateObs(path) : null;
  if (!t0 || Number.isNaN(t0.getTime())) { missing++; continue; }
  const expSec = Number(f[col('expSec')]) || 0;
  const t = new Date(t0.getTime() + expSec * 500); // mid-exposure
  const alt = altitude(ra, dec, lat, lon, jd2000(t));
  const rec = { alt, filter: f[col('filter')], night: f[col('night')], decision: f[col('decision')] };
  for (const mt of METRICS) rec[mt.key] = Number(f[col(mt.key)]);
  subs.push(rec);
}
if (missing) console.error(`  (${missing} report rows had no matching pooled sub -- skipped)`);

const median = (x) => { if (!x.length) return null; const s = [...x].sort((p, q) => p - q); return s[s.length >> 1]; };

// Normalise each metric against its own filter's median.
const filters = [...new Set(subs.map((s) => s.filter))];
const norm = new Map();
for (const flt of filters)
  for (const mt of METRICS)
    norm.set(`${flt}|${mt.key}`, median(subs.filter((s) => s.filter === flt && Number.isFinite(s[mt.key])).map((s) => s[mt.key])));

console.log(`\n${object}  RA ${(ra / 15).toFixed(2)}h  Dec ${dec.toFixed(2)}deg   site ${lat.toFixed(2)}N ${lon.toFixed(2)}E`);
console.log(`${subs.length} subs from ${filters.join(', ')}   transit altitude ${(90 - Math.abs(lat - dec)).toFixed(1)} deg`);
console.log('values are ratios to each filter\'s own median (1.00 = typical); airmass = 1/sin(alt)\n');

const lo = Math.floor(Math.min(...subs.map((s) => s.alt)) / binSize) * binSize;
const hi = Math.ceil(Math.max(...subs.map((s) => s.alt)) / binSize) * binSize;
console.log('  altitude    airmass   subs' + METRICS.map((m) => m.label.padStart(12)).join('') + '     keep%');
for (let b = lo; b < hi; b += binSize) {
  const inBin = subs.filter((s) => s.alt >= b && s.alt < b + binSize);
  if (!inBin.length) continue;
  const mid = b + binSize / 2;
  const cells = METRICS.map((mt) => {
    const vals = inBin.map((s) => s[mt.key] / norm.get(`${s.filter}|${mt.key}`)).filter(Number.isFinite);
    const v = median(vals);
    return v == null ? '-'.padStart(12) : v.toFixed(2).padStart(12);
  });
  const keep = 100 * inBin.filter((s) => s.decision === 'KEEP').length / inBin.length;
  console.log(`  ${String(b).padStart(2)}-${String(b + binSize).padEnd(3)} deg` +
    `${(1 / Math.sin(mid * Math.PI / 180)).toFixed(2).padStart(10)}${String(inBin.length).padStart(7)}` +
    cells.join('') + `${keep.toFixed(0).padStart(9)}%`);
}
console.log('\n  lower is better: FWHM, ecc, sky bg     higher is better: stars, PSF signal');

// Altitude is confounded with season and weather: the low-altitude frames are
// mostly early-season nights when the target was still rising, and those nights
// may simply have been worse. Normalising within (filter, night) instead removes
// every between-night effect, leaving only how quality varies across a single
// session as the target climbs. This is the number to trust for a cutoff.
const grp = new Map();
for (const s of subs) {
  const k = `${s.filter}|${s.night}`;
  if (!grp.has(k)) grp.set(k, []);
  grp.get(k).push(s);
}
const norm2 = new Map();
for (const [k, g] of grp) {
  if (g.length < 3) continue; // too few to define a within-night median
  for (const mt of METRICS)
    norm2.set(`${k}|${mt.key}`, median(g.map((s) => s[mt.key]).filter(Number.isFinite)));
}
const usable = subs.filter((s) => norm2.has(`${s.filter}|${s.night}|fwhmPx`));
console.log(`\nwithin-night comparison (${usable.length} subs in groups of 3+; removes season and weather)`);
console.log('  altitude    airmass   subs' + METRICS.map((m) => m.label.padStart(12)).join(''));
for (let b = lo; b < hi; b += binSize) {
  const inBin = usable.filter((s) => s.alt >= b && s.alt < b + binSize);
  if (!inBin.length) continue;
  const mid = b + binSize / 2;
  const cells = METRICS.map((mt) => {
    const vals = inBin.map((s) => s[mt.key] / norm2.get(`${s.filter}|${s.night}|${mt.key}`)).filter(Number.isFinite);
    const v = median(vals);
    return v == null ? '-'.padStart(12) : v.toFixed(2).padStart(12);
  });
  console.log(`  ${String(b).padStart(2)}-${String(b + binSize).padEnd(3)} deg` +
    `${(1 / Math.sin(mid * Math.PI / 180)).toFixed(2).padStart(10)}${String(inBin.length).padStart(7)}` + cells.join(''));
}

// A cutoff justified by one metric is a cutoff justified by nothing -- binning
// can manufacture a knee. Spearman rank correlation against altitude, on the
// within-night values, says whether independent metrics agree on the trend.
// Star count and PSF signal are worth comparing in particular: one is a
// detection count, the other is flux-weighted, so they fail differently.
function spearman(xs, ys) {
  const n = xs.length;
  if (n < 8) return null;
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(n);
    for (let i = 0; i < n;) {
      let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; ++k) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((p, q) => p + q, 0) / n, my = ry.reduce((p, q) => p + q, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; ++i) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  const r = num / Math.sqrt(dx * dy);
  const t = Math.abs(r) * Math.sqrt((n - 2) / (1 - r * r));
  return { r, n, sig: t > 1.96 };
}

console.log('\nSpearman rank correlation with altitude (within-night values)');
console.log('  metric          full range           below 60 deg');
for (const mt of METRICS) {
  const pick = (set) => {
    const xs = [], ys = [];
    for (const s of set) {
      const d = norm2.get(`${s.filter}|${s.night}|${mt.key}`);
      if (d && Number.isFinite(s[mt.key])) { xs.push(s.alt); ys.push(s[mt.key] / d); }
    }
    return spearman(xs, ys);
  };
  const all = pick(usable), low = pick(usable.filter((s) => s.alt < 60));
  const fmt = (c) => (c == null ? '     n/a      ' : `r=${c.r >= 0 ? '+' : ''}${c.r.toFixed(2)} n=${String(c.n).padEnd(3)}${c.sig ? '*' : ' '}`);
  console.log(`  ${mt.label.padEnd(14)}${fmt(all)}       ${fmt(low)}`);
}
console.log('  * significant at p<0.05.  Sign convention: positive r means the metric');
console.log('    rises with altitude, which is GOOD for stars/PSF signal, BAD for the rest.');
