// ingest-nina.mjs — file NINA captures into the standard storage layout.
//
//   node scripts/ingest-nina.mjs --nina-root <dir> [--dry-run] [options]
//
// Lights go to  Z:/<TARGET>/<night>/LIGHT/
// Flats  go to  D:/telescope_data/flats-triplet/<night>/FLAT/
//
// "night" is the timestamp shifted back 12 h, the convention already used by
// select-subs.mjs and visibly followed by the existing folders (a flat shot at
// 2026-08-01 11:03 lives under 2026-07-31).
//
// Nothing is stacked or calibrated. Sources are never modified or deleted.
//
// OPTIONS
//   --nina-root <dir>  REQUIRED. The NINA folder to ingest (walked recursively).
//   --dry-run          inventory and report only; copy nothing. Run this first.
//   --lights-root <d>  default Z:
//   --flats-root <d>   default D:/telescope_data/flats-triplet
//   --work <dir>       report location, default D:/Temp/nina-ingest
//   --allow-new-target permit creating a target folder that does not yet exist
//                      (off by default: a typo'd sequence name would otherwise
//                      scatter a night into a directory nobody looks in)
//
// Run with the winget Node v24 binary; the `node` on PATH is v10.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const IMAGE_EXT = /\.(fits?|xisf)$/i;

// ---- CLI ------------------------------------------------------------------
function parseArgs(argv) {
  const cfg = {
    ninaRoot: null, dryRun: false,
    lightsRoot: 'Z:', flatsRoot: 'D:/telescope_data/flats-triplet',
    work: 'D:/Temp/nina-ingest', allowNewTarget: false,
  };
  for (let i = 2; i < argv.length; ++i) {
    const a = argv[i];
    const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '');
    if (a === '--dry-run') cfg.dryRun = true;
    else if (a === '--allow-new-target') cfg.allowNewTarget = true;
    else if (a === '--nina-root') cfg.ninaRoot = norm(argv[++i]);
    else if (a === '--lights-root') cfg.lightsRoot = norm(argv[++i]);
    else if (a === '--flats-root') cfg.flatsRoot = norm(argv[++i]);
    else if (a === '--work') cfg.work = norm(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!cfg.ninaRoot) throw new Error('--nina-root is required');
  if (!fs.existsSync(cfg.ninaRoot)) throw new Error(`--nina-root not found: ${cfg.ninaRoot}`);
  return cfg;
}

// ---- FITS header ----------------------------------------------------------
// 2880-byte blocks of 80-char ASCII cards, terminated by an END card. Data
// begins at the next 2880 boundary. NINA writes .fits, so this is the main
// path, not a fallback.
function readFitsHeader(fd) {
  const BLOCK = 2880, CARD = 80;
  const cards = {};
  let offset = 0;
  for (let block = 0; block < 64; ++block) {
    const buf = Buffer.alloc(BLOCK);
    const n = fs.readSync(fd, buf, 0, BLOCK, offset);
    if (n < BLOCK) break;
    offset += BLOCK;
    for (let c = 0; c < BLOCK / CARD; ++c) {
      const card = buf.toString('latin1', c * CARD, (c + 1) * CARD);
      const key = card.slice(0, 8).trim();
      if (key === 'END') return { cards, dataOffset: offset };
      if (!key || card[8] !== '=') continue;
      let v = card.slice(9).split('/')[0].trim();
      const q = v.match(/^'(.*)'$/);
      if (q) v = q[1].trim();
      cards[key] = v;
    }
  }
  throw new Error('no END card in the first 64 header blocks');
}

// ---- XISF header (same approach as scripts/xisf-preview.mjs) --------------
function readXisfHeader(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  if (head.toString('latin1', 0, 8) !== 'XISF0100') throw new Error('not monolithic XISF');
  const xml = Buffer.alloc(head.readUInt32LE(8));
  fs.readSync(fd, xml, 0, xml.length, 16);
  const text = xml.toString('utf8');
  const cards = {};
  for (const m of text.matchAll(/<FITSKeyword name="([^"]+)" value="([^"]*)"/g))
    cards[m[1]] = m[2].replace(/^'|'$/g, '').trim();
  const img = text.match(/<Image\b[^>]*location="attachment:(\d+):(\d+)"/);
  return {
    cards,
    dataOffset: img ? Number(img[1]) : null,
    dataSize: img ? Number(img[2]) : null,
  };
}

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    if (/\.xisf$/i.test(file)) {
      const h = readXisfHeader(fd);
      return { cards: h.cards, dataOffset: h.dataOffset, dataSize: h.dataSize };
    }
    const h = readFitsHeader(fd);
    const bitpix = Math.abs(Number(h.cards.BITPIX) || 16);
    const nx = Number(h.cards.NAXIS1) || 0, ny = Number(h.cards.NAXIS2) || 0;
    return { cards: h.cards, dataOffset: h.dataOffset, dataSize: (bitpix / 8) * nx * ny };
  } finally {
    fs.closeSync(fd);
  }
}

// Hash the PIXEL payload, not the whole file: calibration and capture software
// stamp timestamps into headers, so byte-identical frames can have differing
// file hashes. Three spread slices identify an exact duplicate cheaply.
function pixelHash(file, dataOffset, dataSize) {
  if (dataOffset == null || !(dataSize > 0)) return null;
  const fd = fs.openSync(file, 'r');
  try {
    const hash = crypto.createHash('md5');
    const buf = Buffer.alloc(Math.min(700 * 1024, dataSize));
    for (const frac of [0.15, 0.5, 0.85]) {
      const n = fs.readSync(fd, buf, 0, buf.length,
        dataOffset + Math.min(Math.floor(dataSize * frac), Math.max(0, dataSize - buf.length)));
      hash.update(buf.subarray(0, n));
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function fileHash(file) {
  const hash = crypto.createHash('md5');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

// ---- night boundary (same rule as select-subs.mjs) ------------------------
// night = local timestamp - 12 h, formatted as a LOCAL date.
//
// The local part is essential and easy to get wrong. FITS DATE-OBS is UTC,
// while NINA's filenames and every existing folder on disk are local. A flat
// shot at 2026-08-01 11:03 local is 15:03Z; shifting the UTC instant back 12 h
// and formatting in UTC yields 2026-08-01, but it belongs to the 2026-07-31
// folder — verified by round-tripping the existing library, which mapped 200
// flats into a brand-new directory until this was fixed.
function nightOf(dateObs) {
  const t = new Date(dateObs.endsWith('Z') ? dateObs : dateObs + 'Z');
  if (Number.isNaN(t.getTime())) return null;
  const s = new Date(t.getTime() - 12 * 3600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${s.getFullYear()}-${p(s.getMonth() + 1)}-${p(s.getDate())}`;
}

// ---- walk -----------------------------------------------------------------
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (IMAGE_EXT.test(e.name)) out.push(p);
  }
  return out;
}

const norm = (s) => (s ?? '').toLowerCase().replace(/[\s_-]+/g, '');

// ---- main -----------------------------------------------------------------
const cfg = parseArgs(process.argv);
fs.mkdirSync(cfg.work, { recursive: true });

console.log(`scanning ${cfg.ninaRoot} ...`);
const files = walk(cfg.ninaRoot);
console.log(`${files.length} image file(s) found`);

// Existing target folders — the only legal light destinations unless
// --allow-new-target is given.
const existingTargets = fs.readdirSync(cfg.lightsRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('$') && !/^System Volume/i.test(e.name))
  .map((e) => e.name);
const targetByNorm = new Map(existingTargets.map((t) => [norm(t), t]));

const items = [], problems = [];
const seenPixel = new Map();

for (const f of files) {
  let h;
  try { h = readHeader(f); } catch (e) {
    problems.push({ file: f, why: `unreadable header: ${e.message}` });
    continue;
  }
  const type = (h.cards.IMAGETYP || '').toUpperCase();
  const dateObs = h.cards['DATE-OBS'];
  if (!dateObs) { problems.push({ file: f, why: 'no DATE-OBS' }); continue; }
  const night = nightOf(dateObs);
  if (!night) { problems.push({ file: f, why: `unparseable DATE-OBS "${dateObs}"` }); continue; }

  const item = {
    file: f, name: path.basename(f), size: fs.statSync(f).size,
    type, night, object: h.cards.OBJECT || '', filter: h.cards.FILTER || '',
    pixel: pixelHash(f, h.dataOffset, h.dataSize),
  };

  // Duplicate within the incoming set — the M82 halpha data had one exposure
  // under eight names, all of which got integrated.
  if (item.pixel) {
    if (seenPixel.has(item.pixel)) {
      item.dupOf = seenPixel.get(item.pixel);
      problems.push({ file: f, why: `exact duplicate of ${item.dupOf}` });
      continue;
    }
    seenPixel.set(item.pixel, item.name);
  }

  // The folder a file sits in is only a cross-check; the header decides.
  const pathSaysFlat = /flat/i.test(f), pathSaysLight = /light/i.test(f);
  if (type === 'FLAT' && pathSaysLight)
    problems.push({ file: f, why: 'header says FLAT but path says light — filed by header' });
  if (type === 'LIGHT' && pathSaysFlat)
    problems.push({ file: f, why: 'header says LIGHT but path says flat — filed by header' });

  if (type === 'FLAT') {
    item.dest = `${cfg.flatsRoot}/${night}/FLAT`;
  } else if (type === 'LIGHT') {
    const t = targetByNorm.get(norm(item.object));
    if (!t) { problems.push({ file: f, why: `unknown target "${item.object}" — no folder under ${cfg.lightsRoot}` }); continue; }
    item.dest = `${cfg.lightsRoot}/${t}/${night}/LIGHT`;
  } else {
    problems.push({ file: f, why: `unhandled IMAGETYP "${type}"` });
    continue;
  }
  items.push(item);
}

// ---- plan by destination --------------------------------------------------
const byDest = new Map();
for (const it of items) {
  if (!byDest.has(it.dest)) byDest.set(it.dest, []);
  byDest.get(it.dest).push(it);
}

console.log('\n  destination                                              files      GB');
console.log('  --------------------------------------------------------------------');
let totalBytes = 0, flatBytes = 0;
for (const [dest, g] of [...byDest].sort()) {
  const b = g.reduce((a, x) => a + x.size, 0);
  totalBytes += b;
  if (dest.startsWith(cfg.flatsRoot)) flatBytes += b;
  console.log(`  ${dest.padEnd(54)} ${String(g.length).padStart(5)}  ${(b / 1e9).toFixed(2).padStart(6)}`);
}
console.log(`  ${'TOTAL'.padEnd(54)} ${String(items.length).padStart(5)}  ${(totalBytes / 1e9).toFixed(2).padStart(6)}`);

if (problems.length) {
  console.log(`\n${problems.length} item(s) need attention:`);
  for (const p of problems.slice(0, 40)) console.log(`  ${path.basename(p.file)} — ${p.why}`);
  if (problems.length > 40) console.log(`  ... and ${problems.length - 40} more (see the report)`);
}

// ---- space check ----------------------------------------------------------
function freeBytes(dir) {
  try {
    const root = path.parse(path.resolve(dir)).root;
    return Number(fs.statfsSync(root).bavail) * Number(fs.statfsSync(root).bsize);
  } catch { return null; }
}
const flatsFree = freeBytes(cfg.flatsRoot), lightsFree = freeBytes(cfg.lightsRoot);
const lightBytes = totalBytes - flatBytes;
const HEADROOM = 5e9;
console.log(`\nspace: flats need ${(flatBytes / 1e9).toFixed(2)} GB, ` +
  `${cfg.flatsRoot} has ${flatsFree == null ? '?' : (flatsFree / 1e9).toFixed(0)} GB free`);
console.log(`       lights need ${(lightBytes / 1e9).toFixed(2)} GB, ` +
  `${cfg.lightsRoot} has ${lightsFree == null ? '?' : (lightsFree / 1e9).toFixed(0)} GB free`);
if (flatsFree != null && flatBytes + HEADROOM > flatsFree)
  throw new Error(`not enough room for flats on ${cfg.flatsRoot} — stopping rather than filling the disk`);
if (lightsFree != null && lightBytes + HEADROOM > lightsFree)
  throw new Error(`not enough room for lights on ${cfg.lightsRoot} — stopping`);

if (cfg.dryRun) {
  writeReport('DRY RUN — nothing copied');
  console.log(`\nDRY RUN — nothing copied. Report: ${cfg.work}/report.md`);
  process.exit(0);
}

// ---- copy + verify --------------------------------------------------------
let copied = 0, skipped = 0, collisions = 0;
for (const [dest, g] of [...byDest].sort()) {
  fs.mkdirSync(dest, { recursive: true });
  for (const it of g) {
    const out = `${dest}/${it.name}`;
    if (fs.existsSync(out)) {
      const same = fs.statSync(out).size === it.size && fileHash(out) === fileHash(it.file);
      if (same) { it.result = 'skipped-identical'; ++skipped; continue; }
      it.result = 'COLLISION — different content, left alone';
      ++collisions;
      console.warn(`  COLLISION ${out}`);
      continue;
    }
    fs.copyFileSync(it.file, out);
    if (fs.statSync(out).size !== it.size || fileHash(out) !== fileHash(it.file))
      throw new Error(`verification FAILED after copying ${it.file}`);
    it.result = 'copied';
    ++copied;
    if (copied % 25 === 0) console.log(`  ${copied} copied ...`);
  }
}
console.log(`\ncopied ${copied}, skipped-identical ${skipped}, collisions ${collisions}`);
writeReport(`copied ${copied}, skipped ${skipped}, collisions ${collisions}`);
console.log(`Report: ${cfg.work}/report.md`);

// ---- report ---------------------------------------------------------------
function writeReport(headline) {
  const md = [`# NINA ingest — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, '',
    `Source: \`${cfg.ninaRoot}\` (unmodified)`, '', `**${headline}**`, '',
    '| destination | files | GB |', '|---|---|---|'];
  for (const [dest, g] of [...byDest].sort())
    md.push(`| \`${dest}\` | ${g.length} | ${(g.reduce((a, x) => a + x.size, 0) / 1e9).toFixed(2)} |`);
  if (problems.length) {
    md.push('', '## Needs attention', '');
    for (const p of problems) md.push(`- \`${path.basename(p.file)}\` — ${p.why}`);
  }
  md.push('', '## Files', '', '| file | type | target/night | filter | result |', '|---|---|---|---|---|');
  for (const it of items)
    md.push(`| ${it.name} | ${it.type} | ${it.object || '-'} / ${it.night} | ${it.filter || '-'} | ${it.result ?? 'planned'} |`);
  fs.writeFileSync(`${cfg.work}/report.md`, md.join('\n') + '\n');
}
