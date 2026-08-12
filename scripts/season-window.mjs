// season-window.mjs — how much usable dark time is left on a target this season.
//
//   node scripts/season-window.mjs --from-master <master.xisf> [--min-alt 30]
//        [--start 2026-08-12] [--end 2027-01-31] [--clear-rate 0.33] [--h-per-night 3.3]
//   node scripts/season-window.mjs --ra 299.98 --dec 35.28 --lat 39.93 --lon -75.39
//
// Reports, per month: nights on which the target clears --min-alt during
// astronomical darkness (sun < -18 deg), the summed usable hours, and how many
// of those hours are moon-free. Then projects realistic capture by applying an
// observed clear-night rate and hours-per-night.
//
// Target position and site coordinates are read straight out of a master's FITS
// keywords (RA/DEC + OBSGEO-B/OBSGEO-L), so this needs no configuration.
//
// Accuracy: low-precision solar and lunar ephemerides (Meeus, truncated). Sun to
// ~0.01 deg, moon to ~0.3 deg -- far tighter than weather uncertainty, which is
// what actually dominates the answer.
import fs from 'fs';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const sin = (d) => Math.sin(d * D2R), cos = (d) => Math.cos(d * D2R);
const norm = (d) => ((d % 360) + 360) % 360;

function masterKeywords(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.toString('latin1', 0, 8) !== 'XISF0100') throw new Error('not monolithic XISF');
    const xml = Buffer.alloc(head.readUInt32LE(8));
    fs.readSync(fd, xml, 0, xml.length, 16);
    const s = xml.toString('utf8');
    const kw = (n) => {
      const m = s.match(new RegExp(`<FITSKeyword name="${n}" value="([^"]*)"`));
      return m ? Number(m[1].replace(/'/g, '').trim()) : null;
    };
    const obj = s.match(/<FITSKeyword name="OBJECT" value="'?([^"']*)/);
    return { ra: kw('RA'), dec: kw('DEC'), lat: kw('OBSGEO-B') ?? kw('LAT-OBS'),
      lon: kw('OBSGEO-L') ?? kw('LONG-OBS'), object: obj ? obj[1].trim() : '?' };
  } finally { fs.closeSync(fd); }
}

// Days since J2000.0 for a JS Date (UTC).
const jd2000 = (date) => date.getTime() / 86400000 + 2440587.5 - 2451545.0;

function sunPos(n) {
  const L = norm(280.460 + 0.9856474 * n);
  const g = norm(357.528 + 0.9856003 * n);
  const lam = L + 1.915 * sin(g) + 0.020 * sin(2 * g);
  const eps = 23.439 - 0.0000004 * n;
  const ra = Math.atan2(cos(eps) * sin(lam), cos(lam)) * R2D;
  const dec = Math.asin(sin(eps) * sin(lam)) * R2D;
  return { ra: norm(ra), dec };
}

function moonPos(n) {
  const T = n / 36525;
  const Lp = norm(218.316 + 481267.8813 * T);
  const M = norm(357.529 + 35999.0503 * T);
  const Mp = norm(134.963 + 477198.8676 * T);
  const Dm = norm(297.850 + 445267.1115 * T);
  const F = norm(93.272 + 483202.0175 * T);
  const lam = Lp + 6.289 * sin(Mp) - 1.274 * sin(2 * Dm - Mp) + 0.658 * sin(2 * Dm)
    + 0.214 * sin(2 * Mp) - 0.186 * sin(M) - 0.114 * sin(2 * F);
  const bet = 5.128 * sin(F) + 0.281 * sin(Mp + F) - 0.278 * sin(F - Mp) - 0.173 * sin(2 * Dm - F);
  const eps = 23.439 - 0.0000004 * n;
  const ra = Math.atan2(sin(lam) * cos(eps) - Math.tan(bet * D2R) * sin(eps), cos(lam)) * R2D;
  const dec = Math.asin(sin(bet) * cos(eps) + cos(bet) * sin(eps) * sin(lam)) * R2D;
  return { ra: norm(ra), dec };
}

// Greenwich mean sidereal time, degrees.
const gmst = (n) => norm(280.46061837 + 360.98564736629 * n);
function altitude(ra, dec, lat, lon, n) {
  const ha = norm(gmst(n) + lon - ra);
  return Math.asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(ha)) * R2D;
}

// --- args -------------------------------------------------------------------
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i < 0 ? d : a[i + 1]; };
let { ra, dec, lat, lon, object } = opt('--from-master')
  ? masterKeywords(opt('--from-master'))
  : { object: opt('--name', 'target') };
ra = Number(opt('--ra', ra)); dec = Number(opt('--dec', dec));
lat = Number(opt('--lat', lat)); lon = Number(opt('--lon', lon));
if ([ra, dec, lat, lon].some((v) => !Number.isFinite(v))) {
  console.error('need --from-master, or all of --ra --dec --lat --lon');
  process.exit(2);
}
const minAlt = Number(opt('--min-alt', 30));
const start = new Date(`${opt('--start', new Date().toISOString().slice(0, 10))}T00:00:00Z`);
const end = new Date(`${opt('--end', '2027-02-28')}T00:00:00Z`);
const clearRate = Number(opt('--clear-rate', 0));
const hPerNight = Number(opt('--h-per-night', 0));

console.log(`\n${object}  RA ${(ra / 15).toFixed(2)}h  Dec ${dec.toFixed(2)}deg   site ${lat.toFixed(2)}N ${lon.toFixed(2)}E`);
console.log(`transit altitude ${(90 - Math.abs(lat - dec)).toFixed(1)}deg   usable above ${minAlt}deg` +
  `   window ${start.toISOString().slice(0, 10)} .. ${end.toISOString().slice(0, 10)}`);

// --- sweep ------------------------------------------------------------------
// One minute steps. Each minute is assigned to the observing night it belongs
// to: shift by the site's longitude so the boundary falls at local noon.
const STEP = 60000, lonHours = lon / 15;
const nights = new Map();
for (let t = start.getTime(); t < end.getTime(); t += STEP) {
  const d = new Date(t);
  const n = jd2000(d);
  const s = sunPos(n);
  if (altitude(s.ra, s.dec, lat, lon, n) >= -18) continue; // not astronomically dark
  if (altitude(ra, dec, lat, lon, n) < minAlt) continue;   // target too low
  const key = new Date(t + (lonHours - 12) * 3600000).toISOString().slice(0, 10);
  if (!nights.has(key)) nights.set(key, { h: 0, dark: 0 });
  const rec = nights.get(key);
  rec.h += STEP / 3600000;
  const m = moonPos(n);
  const moonUp = altitude(m.ra, m.dec, lat, lon, n) > 0;
  const elong = Math.acos(sin(s.dec) * sin(m.dec) + cos(s.dec) * cos(m.dec) * cos(s.ra - m.ra)) * R2D;
  const illum = (1 - cos(elong)) / 2;
  if (!moonUp || illum < 0.4) rec.dark += STEP / 3600000;
}

const bym = new Map();
for (const [k, v] of nights) {
  const ym = k.slice(0, 7);
  if (!bym.has(ym)) bym.set(ym, { nights: 0, h: 0, dark: 0, best: 0 });
  const r = bym.get(ym);
  r.nights++; r.h += v.h; r.dark += v.dark; r.best = Math.max(r.best, v.h);
}

console.log('\n  month     nights   avail h   best night   moon-free h' +
  (clearRate ? '    projected h' : ''));
let projTotal = 0, availTotal = 0, darkTotal = 0;
for (const ym of [...bym.keys()].sort()) {
  const r = bym.get(ym);
  availTotal += r.h; darkTotal += r.dark;
  // Realistic capture: clear nights only, capped by what actually fits in the
  // night. Hours-per-night is the observed session length, not the window.
  const proj = clearRate ? r.nights * clearRate * Math.min(hPerNight || r.h / r.nights, r.h / r.nights) : 0;
  projTotal += proj;
  console.log(`  ${ym.padEnd(10)}${String(r.nights).padStart(5)}${r.h.toFixed(1).padStart(10)}` +
    `${r.best.toFixed(1).padStart(13)}${r.dark.toFixed(1).padStart(14)}` +
    (clearRate ? `${proj.toFixed(1).padStart(15)}` : ''));
}
console.log(`  ${'TOTAL'.padEnd(10)}${String(nights.size).padStart(5)}${availTotal.toFixed(1).padStart(10)}` +
  `${''.padStart(13)}${darkTotal.toFixed(1).padStart(14)}` +
  (clearRate ? `${projTotal.toFixed(1).padStart(15)}` : ''));
if (clearRate) console.log(`\n  projection assumes ${(100 * clearRate).toFixed(0)}% of nights usable` +
  `${hPerNight ? ` and ${hPerNight} h captured per usable night` : ''}`);
