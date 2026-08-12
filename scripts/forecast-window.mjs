// forecast-window.mjs — usable imaging hours from a REAL forecast, not a rate.
//
//   node scripts/forecast-window.mjs --from-master <master.xisf> [--min-alt 60]
//        [--max-cloud 20] [--clear-rate 0.28] [--hours-per-night 3.3]
//
// Sends the site's latitude/longitude to two public forecast APIs (no key, no
// account): Open-Meteo for hourly cloud cover, 7Timer ASTRO for seeing and
// transparency.
//
// FORECAST HORIZONS ARE THE WHOLE POINT HERE, so they are stated in the output:
//   seeing        3 days   (7Timer ASTRO, 72 h, 3-hourly). This is a hard limit.
//                          Seeing comes from boundary-layer turbulence and jet
//                          shear; nothing forecasts it usefully beyond ~3 days,
//                          and no provider offers more.
//   cloud cover  16 days   (Open-Meteo). Genuine skill to ~7 days, marginal to
//                          ~10, and effectively climatology past that.
//   beyond               fall back to the measured clear-night rate. A monthly
//                          plan CANNOT be forecast -- that tail is climatology
//                          whether it comes from a model or from history.
//
// Hours are only counted when the sky is astronomically dark AND the target is
// above --min-alt, so this composes with season-window.mjs rather than
// duplicating it.
import { jd2000, sunPos, altitude, moonIllumination, moonPos, masterKeywords } from './lib/astro.mjs';

// 7Timer seeing index -> arcsec bin.
const SEEING = ['', '<0.5"', '0.5-0.75"', '0.75-1"', '1-1.25"', '1.25-1.5"', '1.5-2"', '2-2.5"', '>2.5"'];
// 7Timer transparency index -> magnitude loss bin.
const TRANSP = ['', '<0.3', '0.3-0.4', '0.4-0.5', '0.5-0.6', '0.6-0.7', '0.7-0.85', '0.85-1', '>1'];

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i < 0 ? d : a[i + 1]; };
let { ra, dec, lat, lon, object } = opt('--from-master')
  ? masterKeywords(opt('--from-master')) : { object: opt('--name', 'target') };
ra = Number(opt('--ra', ra)); dec = Number(opt('--dec', dec));
lat = Number(opt('--lat', lat)); lon = Number(opt('--lon', lon));
if ([ra, dec, lat, lon].some((v) => !Number.isFinite(v))) {
  console.error('need --from-master, or all of --ra --dec --lat --lon');
  process.exit(2);
}
const minAlt = Number(opt('--min-alt', 30));
const maxCloud = Number(opt('--max-cloud', 20));
const clearRate = Number(opt('--clear-rate', 0.28));
const hoursPerNight = Number(opt('--hours-per-night', 3.3));

const get = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
};

const om = await get('https://api.open-meteo.com/v1/forecast'
  + `?latitude=${lat}&longitude=${lon}&hourly=cloud_cover&forecast_days=16&timezone=GMT`);
let astro = null;
try {
  astro = await get(`https://www.7timer.info/bin/astro.php?lon=${lon}&lat=${lat}&ac=0&unit=metric&output=json&tzshift=0`);
} catch (e) { console.error(`  (7Timer unavailable: ${e.message} -- continuing without seeing)`); }

// 7Timer timepoints are hours after its init time; snap each to a UTC hour.
const seeingAt = new Map();
if (astro) {
  const init = astro.init.match(/(\d{4})(\d{2})(\d{2})(\d{2})/);
  const t0 = Date.UTC(+init[1], +init[2] - 1, +init[3], +init[4]);
  for (const d of astro.dataseries) {
    const t = t0 + d.timepoint * 3600000;
    // Each 3-hourly sample covers the following 3 hours.
    for (let k = 0; k < 3; ++k) seeingAt.set(new Date(t + k * 3600000).toISOString().slice(0, 13), d);
  }
}

const cloudAt = new Map();
om.hourly.time.forEach((t, i) => cloudAt.set(`${t.slice(0, 13)}`, om.hourly.cloud_cover[i]));

console.log(`\n${object}  RA ${(ra / 15).toFixed(2)}h  Dec ${dec.toFixed(2)}deg   site ${lat.toFixed(2)}N ${lon.toFixed(2)}E`);
console.log(`usable above ${minAlt} deg, clear means cloud cover <= ${maxCloud}%`);
console.log(`cloud: Open-Meteo, ${om.hourly.time.length / 24} days` +
  (astro ? `   seeing: 7Timer ASTRO init ${astro.init}, ${astro.dataseries[astro.dataseries.length - 1].timepoint / 24} days` : '   seeing: unavailable'));

// Walk every hour of the cloud forecast; keep the astronomically usable ones.
const nights = new Map();
const lonHours = lon / 15;
const now = Date.now();
for (const t of om.hourly.time) {
  const d = new Date(`${t}:00Z`);
  if (d.getTime() < now) continue; // don't report hours that have already passed
  const n = jd2000(d);
  const s = sunPos(n);
  if (altitude(s.ra, s.dec, lat, lon, n) >= -18) continue;
  if (altitude(ra, dec, lat, lon, n) < minAlt) continue;
  const key = new Date(d.getTime() + (lonHours - 12) * 3600000).toISOString().slice(0, 10);
  if (!nights.has(key)) nights.set(key, { dark: 0, clear: 0, cloud: [], seeing: [], transp: [], moon: [] });
  const rec = nights.get(key);
  rec.dark += 1;
  const c = cloudAt.get(t.slice(0, 13));
  if (c != null) { rec.cloud.push(c); if (c <= maxCloud) rec.clear += 1; }
  const sk = seeingAt.get(t.slice(0, 13));
  if (sk) { rec.seeing.push(sk.seeing); rec.transp.push(sk.transparency); }
  const m = moonPos(n);
  rec.moon.push(altitude(m.ra, m.dec, lat, lon, n) > 0 ? moonIllumination(n) : 0);
}

const avg = (x) => (x.length ? x.reduce((p, q) => p + q, 0) / x.length : null);
const med = (x) => { if (!x.length) return null; const s = [...x].sort((p, q) => p - q); return s[s.length >> 1]; };

console.log('\n  night         dark   clear    cloud     moon   seeing          transparency   verdict');
console.log('              (hours) (hours)');
let clearTotal = 0, darkTotal = 0;
for (const [k, v] of [...nights.entries()].sort()) {
  darkTotal += v.dark; clearTotal += v.clear;
  const c = avg(v.cloud), mo = avg(v.moon), se = med(v.seeing), tr = med(v.transp);
  // Rank on clear hours first -- cloud is binary for imaging. Seeing and moon
  // are qualifiers on an already-viable night; they must never promote a mostly
  // clouded night above a clear one just because a seeing forecast exists for it.
  let verdict;
  if (v.clear < 1) verdict = 'clouded out';
  else if (v.clear < 2) verdict = 'marginal';
  else if (mo >= 0.4) verdict = 'GO - moonlit';
  else verdict = 'GO';
  if (v.clear >= 2 && se != null) verdict += se <= 4 ? ' (seeing good)' : se >= 7 ? ' (seeing poor)' : '';
  console.log(`  ${k}${v.dark.toFixed(0).padStart(7)}${v.clear.toFixed(0).padStart(8)}` +
    `${(c == null ? '-' : `${c.toFixed(0)}%`).padStart(9)}${(mo == null ? '-' : `${(100 * mo).toFixed(0)}%`).padStart(9)}` +
    `   ${(se == null ? 'no forecast' : SEEING[se]).padEnd(16)}${(tr == null ? '-' : TRANSP[tr]).padEnd(15)}${verdict}`);
}

const days = nights.size;
console.log(`\n  forecast window: ${clearTotal.toFixed(0)} clear usable hours of ${darkTotal.toFixed(0)} dark hours` +
  ` over ${days} nights (${(100 * clearTotal / darkTotal).toFixed(0)}% clear)`);
console.log(`  for comparison, the ${(100 * clearRate).toFixed(0)}% historical rate over the same ${days} nights` +
  ` predicts ${(days * clearRate * hoursPerNight).toFixed(0)} hours`);
console.log(`\n  BEYOND ${[...nights.keys()].sort().pop()}: no forecast. Seeing has no skill past 3 days and`);
console.log('  cloud cover none past ~10; use season-window.mjs with the historical clear rate.');
