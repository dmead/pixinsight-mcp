// season-window.mjs — how much usable dark time is left on a target this season.
//
//   node scripts/season-window.mjs --from-master <master.xisf> [--min-alt 30]
//        [--start 2026-08-12] [--end 2027-01-31] [--clear-rate 0.33] [--hours-per-night 3.3]
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
import { jd2000, sunPos, moonPos, altitude, moonIllumination, masterKeywords } from './lib/astro.mjs';

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
const hoursPerNight = Number(opt('--hours-per-night', 0));

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
  if (!moonUp || moonIllumination(n) < 0.4) rec.dark += STEP / 3600000;
}

const bym = new Map();
for (const [k, v] of nights) {
  const ym = k.slice(0, 7);
  if (!bym.has(ym)) bym.set(ym, { nights: 0, h: 0, dark: 0, best: 0 });
  const r = bym.get(ym);
  r.nights++; r.h += v.h; r.dark += v.dark; r.best = Math.max(r.best, v.h);
}

// All numeric columns except "nights" are hours.
console.log('\n  ' + 'month'.padEnd(10) + 'nights'.padStart(7) + 'available'.padStart(11) +
  'best night'.padStart(13) + 'moon-free'.padStart(13) + (clearRate ? 'projected'.padStart(13) : ''));
console.log('  ' + ''.padEnd(10) + ''.padStart(7) + '(hours)'.padStart(11) +
  '(hours)'.padStart(13) + '(hours)'.padStart(13) + (clearRate ? '(hours)'.padStart(13) : ''));
let projTotal = 0, availTotal = 0, darkTotal = 0;
for (const ym of [...bym.keys()].sort()) {
  const r = bym.get(ym);
  availTotal += r.h; darkTotal += r.dark;
  // Realistic capture: clear nights only, capped by what actually fits in the
  // night. Hours per night is the observed session length, not the window.
  const proj = clearRate ? r.nights * clearRate * Math.min(hoursPerNight || r.h / r.nights, r.h / r.nights) : 0;
  projTotal += proj;
  console.log(`  ${ym.padEnd(10)}${String(r.nights).padStart(7)}${r.h.toFixed(1).padStart(11)}` +
    `${r.best.toFixed(1).padStart(13)}${r.dark.toFixed(1).padStart(13)}` +
    (clearRate ? `${proj.toFixed(1).padStart(13)}` : ''));
}
console.log(`  ${'TOTAL'.padEnd(10)}${String(nights.size).padStart(7)}${availTotal.toFixed(1).padStart(11)}` +
  `${''.padStart(13)}${darkTotal.toFixed(1).padStart(13)}` +
  (clearRate ? `${projTotal.toFixed(1).padStart(13)}` : ''));
if (clearRate) console.log(`\n  projection assumes ${(100 * clearRate).toFixed(0)}% of nights usable` +
  `${hoursPerNight ? ` and ${hoursPerNight} hours captured per usable night` : ''}`);
