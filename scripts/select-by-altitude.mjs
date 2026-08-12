// select-by-altitude.mjs — filter a calibrated pool by target altitude.
//
//   node scripts/select-by-altitude.mjs --from-master <master.xisf> --pool <dir>   (report only)
//   node scripts/select-by-altitude.mjs --from-master <master.xisf> --pool <dir> \
//        --cutoff 40 --out <dir>                                                   (assemble)
//
// Altitude comes from each frame's DATE-OBS (UTC) plus the site coordinates in
// the master -- NOT from the filename stamp, which is LOCAL time and runs 4
// hours behind DATE-OBS during EDT. Every frame can be filtered this way with no
// star measurement, so the criterion applies uniformly across the whole pool
// rather than only to the subset some selection report happens to cover.
//
// Assembly hardlinks (same volume) and falls back to copying, matching how the
// pool itself is built.
import fs from 'fs';
import { jd2000, altitude, masterKeywords } from './lib/astro.mjs';

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i < 0 ? d : a[i + 1]; };
const { ra, dec, lat, lon, object } = masterKeywords(opt('--from-master'));
const pool = opt('--pool');
const cutoff = opt('--cutoff') == null ? null : Number(opt('--cutoff'));
const out = opt('--out');
const FILTERS = ['lum', 'red', 'green', 'blue', 'halpha', 'oxygen3', 'sulfur'];

function headerOf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.toString('latin1', 0, 8) !== 'XISF0100') return null;
    const xml = Buffer.alloc(head.readUInt32LE(8));
    fs.readSync(fd, xml, 0, xml.length, 16);
    const s = xml.toString('utf8');
    const kw = (n) => {
      const m = s.match(new RegExp(`<FITSKeyword name="${n}" value="'?([^"']*)`));
      return m ? m[1].trim() : null;
    };
    return { dateObs: kw('DATE-OBS'), exp: Number(kw('EXPTIME')) || 0 };
  } catch { return null; } finally { fs.closeSync(fd); }
}

const frames = [];
let noHeader = 0;
for (const f of fs.readdirSync(pool)) {
  if (!/\.xisf$/i.test(f)) continue;
  const h = headerOf(`${pool}/${f}`);
  if (!h || !h.dateObs) { noHeader++; continue; }
  const t = new Date(`${h.dateObs}Z`);
  if (Number.isNaN(t.getTime())) { noHeader++; continue; }
  const mid = new Date(t.getTime() + h.exp * 500);
  frames.push({
    file: f, exp: h.exp,
    filter: FILTERS.find((x) => new RegExp(x, 'i').test(f)) || '?',
    alt: altitude(ra, dec, lat, lon, jd2000(mid)),
  });
}

console.log(`\n${object}  ${frames.length} frames in pool${noHeader ? ` (${noHeader} unreadable, skipped)` : ''}`);
const cuts = cutoff == null ? [0, 30, 35, 40, 45, 50, 60] : [cutoff];
console.log('\n  cutoff' + FILTERS.map((f) => f.slice(0, 7).padStart(9)).join('') + '     total     hours');
for (const c of cuts) {
  const kept = frames.filter((f) => f.alt >= c);
  console.log(`  ${String(c).padStart(3)} deg` +
    FILTERS.map((f) => String(kept.filter((k) => k.filter === f).length).padStart(9)).join('') +
    String(kept.length).padStart(10) + (kept.reduce((p, q) => p + q.exp, 0) / 3600).toFixed(1).padStart(10));
}

if (cutoff != null && out) {
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(out)) fs.rmSync(`${out}/${f}`, { force: true });
  let linked = 0, copied = 0;
  for (const f of frames.filter((x) => x.alt >= cutoff)) {
    try { fs.linkSync(`${pool}/${f.file}`, `${out}/${f.file}`); linked++; }
    catch { fs.copyFileSync(`${pool}/${f.file}`, `${out}/${f.file}`); copied++; }
  }
  const dropped = frames.filter((x) => x.alt < cutoff);
  fs.writeFileSync(`${out}/../altitude-excluded.txt`,
    dropped.sort((p, q) => p.alt - q.alt).map((d) => `${d.alt.toFixed(1)}  ${d.file}`).join('\n'));
  console.log(`\n  assembled ${linked + copied} frames into ${out} (${linked} hardlinked, ${copied} copied)`);
  console.log(`  excluded ${dropped.length} below ${cutoff} deg -> altitude-excluded.txt`);
}
