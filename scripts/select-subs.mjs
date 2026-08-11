// select-subs.mjs — measure calibrated subs headlessly, cull statistical
// outliers (star shape, seeing, clouds, sky background, per-sub gradient),
// copy winners to a destination folder, and write selection reports.
//
// DATASET-AGNOSTIC: paths are arguments and filters are discovered from the
// filenames, so a new target needs no code change.
//
// Run with the winget Node v24 binary (PATH node is v10 and dies on import):
//
//   node scripts/select-subs.mjs --src <dir> --dest <dir> [options]
//
// PATHS
//   --src   <dir>   REQUIRED. Calibrated subs to measure. Point at the set you
//                   will actually stack — if you cosmetic-correct first, use
//                   the corrected folder, not the pre-CC one.
//   --dest  <dir>   REQUIRED. Winners are COPIED here (originals untouched).
//                   The two reports are copied here as well.
//   --work  <dir>   Scratch for CSVs, logs, reports. Keep it LOCAL, never on a
//                   share — the PJSR script rewrites its log per line and an
//                   SMB reader can lock it. Default: D:/Temp/<dest-name>-select
//   --label <text>  Title used in the report. Default: parent dir of --dest.
//
// SELECTION (all thresholds are robust z-scores: MAD-based, per filter group,
// so each filter is judged against its own population)
//   --sigma-ecc   2.5   reject z > this   elongated stars (guiding/wind)
//   --sigma-fwhm  2.5   reject z > this   bloated stars (seeing/focus)
//   --sigma-stars 2.5   reject z < -this  LOW star count (clouds)
//   --sigma-bg    3.0   reject z > this   high sky background per second
//                                         (moon/glow); normalized by exposure
//                                         so mixed exposure tiers compare.
//                                         TWO-CONDITION: must ALSO exceed
//                                         --bg-ratio x the filter median.
//   --bg-ratio    1.5   absolute guard on the background test. Narrowband sky
//                       sits near zero, so the MAD is tiny and normal
//                       night-to-night variation looks like 3-6 sigma; without
//                       this guard the halpha cut INVERTED and threw away the
//                       best frames. Raise to be more permissive on sky level,
//                       lower to be stricter. Set 0 to disable the guard and
//                       get pure z-score behaviour.
//   --sigma-grad  2.5   reject z > this   strong gradient, measured as corner-
//                                         only spread so a constant pedestal
//                                         and central target signal cancel
//   --ecc-cap     0.72  absolute eccentricity reject, regardless of z. Catches
//                       a whole night that is uniformly bad, which a per-group
//                       z-score cannot see. RAISE for rigs with systemic
//                       elongation (Sh2-101 sat near 0.6) or it culls
//                       everything; LOWER to be stricter.
//   --max-reject  0.35  safety rail: never reject more than this fraction of a
//                       filter. On breach the least-bad frames are un-rejected
//                       and a warning is printed — treat that warning as a sign
//                       the thresholds are wrong for this data, not as success.
//
// MODES
//   --dry-run       measure + report, copy nothing. ALWAYS run this first.
//   --probe         measure 3 frames of the most populous filter and dump
//                   SubframeSelector column indices. Use when a PI upgrade may
//                   have moved the measurement columns.
//   --remeasure     ignore cached CSVs and measure again.
//   --filters a,b   restrict processing (and copying) to these filters.
//   --include a,b   copy these filters too, on top of --filters.
//
// Measurement is one headless PixInsight instance per filter, sequential.
// Completion is judged by output files (status file + CSV), never by log
// activity or process liveness.
//
// Validated on Sh2-101 (2026-07-18): 363 subs -> 244 kept. See
// .claude/skills/pixinsight-pipeline/reference/sub-selection.md

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PIX = 'C:/Program Files/PixInsight/bin/PixInsight.exe';
const SWAP = 'D:\\Temp\\pixinsight-swap';
const MEASURE_SCRIPT = path.join(ROOT, 'pjsr', 'measure-subs.js').replace(/\\/g, '/');

// Source, destination and scratch directories are CLI arguments — this tool is
// dataset-agnostic. Filters are discovered from the filenames rather than
// listed, so a new target needs no code change.
let SRC = null, DEST = null, WORK = null, LABEL = null;

const POLL_MS = 30_000;
const FIRST_STATUS_TIMEOUT_MS = 10 * 60_000;   // watcher script writes status at start
const STALE_STATUS_TIMEOUT_MS = 25 * 60_000;   // one 25-sub SFS batch over SMB
const ABSOLUTE_TIMEOUT_MS = 4 * 3600_000;
const MAX_RETRIES = 2;

// ---- launch mutex (from pix-planetary/scripts/pi-lock.mjs): instances that
// start within the same window race the instance slot and hang ----
const LOCK = 'D:/Temp/pi-launch.lock';
async function withPiLaunchLock(fn) {
  for (;;) {
    try {
      const fd = fs.openSync(LOCK, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch {
      try {
        const age = Date.now() - fs.statSync(LOCK).mtimeMs;
        if (age > 45_000) { fs.rmSync(LOCK, { force: true }); continue; }
      } catch { /* lock vanished */ }
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
    }
  }
  try {
    const result = await fn();
    await new Promise((r) => setTimeout(r, 6000));
    return result;
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

// ---- CLI ----
function parseArgs(argv) {
  const cfg = {
    dryRun: false, probe: false, remeasure: false,
    filters: null, include: [],
    sigmaEcc: 2.5, sigmaFwhm: 2.5, sigmaStars: 2.5, sigmaBg: 3.0, sigmaGrad: 2.5,
    eccCap: 0.72, maxReject: 0.35, bgRatio: 1.5,
    src: null, dest: null, work: null, label: null,
  };
  for (let i = 2; i < argv.length; ++i) {
    const a = argv[i];
    if (a === '--dry-run') cfg.dryRun = true;
    else if (a === '--probe') cfg.probe = true;
    else if (a === '--remeasure') cfg.remeasure = true;
    else if (a === '--src') cfg.src = argv[++i].replace(/\\/g, '/').replace(/\/+$/, '');
    else if (a === '--dest') cfg.dest = argv[++i].replace(/\\/g, '/').replace(/\/+$/, '');
    else if (a === '--work') cfg.work = argv[++i].replace(/\\/g, '/').replace(/\/+$/, '');
    else if (a === '--label') cfg.label = argv[++i];
    else if (a === '--filters') cfg.filters = argv[++i].split(',');
    else if (a === '--include') cfg.include = argv[++i].split(',');
    else if (a === '--sigma-ecc') cfg.sigmaEcc = Number(argv[++i]);
    else if (a === '--sigma-fwhm') cfg.sigmaFwhm = Number(argv[++i]);
    else if (a === '--sigma-stars') cfg.sigmaStars = Number(argv[++i]);
    else if (a === '--sigma-bg') cfg.sigmaBg = Number(argv[++i]);
    else if (a === '--sigma-grad') cfg.sigmaGrad = Number(argv[++i]);
    else if (a === '--ecc-cap') cfg.eccCap = Number(argv[++i]);
    else if (a === '--max-reject') cfg.maxReject = Number(argv[++i]);
    else if (a === '--bg-ratio') cfg.bgRatio = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!cfg.src || !cfg.dest)
    throw new Error('--src and --dest are required');
  if (!fs.existsSync(cfg.src))
    throw new Error(`--src does not exist: ${cfg.src}`);
  if (path.resolve(cfg.src) === path.resolve(cfg.dest))
    throw new Error('--src and --dest must differ');
  cfg.label ??= path.basename(path.dirname(cfg.dest)) || path.basename(cfg.dest);
  cfg.work ??= `D:/Temp/${path.basename(cfg.dest)}-select`;
  SRC = cfg.src; DEST = cfg.dest; WORK = cfg.work; LABEL = cfg.label;
  return cfg;
}

// ---- enumeration ----
// Trailing processing tags vary by dataset: `_c` (calibrated), `_c_cc`
// (calibrated + cosmetic-corrected), and so on. Accept any chain of them
// rather than pinning one, or a CC'd set silently enumerates as zero subs.
// `(N)` is a Windows copy suffix on a filename collision — parse it, don't
// drop it, so the frame is judged rather than silently ignored.
const NAME_RE = /^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})_([a-z0-9]*)_(-?\d+(?:\.\d+)?)_(\d+(?:\.\d+)?)s_(\d+)(?:\(\d+\))?((?:_[a-z]+)*)\.xisf$/i;

function enumerate() {
  const subs = [];
  const unparsed = [];
  for (const name of fs.readdirSync(SRC)) {
    if (!name.toLowerCase().endsWith('.xisf')) continue;
    const full = `${SRC}/${name}`;
    if (full.includes(',') || full.includes('"'))
      throw new Error(`Path contains comma/quote (breaks -r= args and CSV): ${full}`);
    const m = name.match(NAME_RE);
    if (!m) { unparsed.push(name); continue; }
    const [, date, time, filterRaw, temp, exp] = m;
    const ts = new Date(`${date}T${time.replace(/-/g, ':')}`);
    const night = new Date(ts.getTime() - 12 * 3600_000).toISOString().slice(0, 10);
    subs.push({
      name, path: full,
      filter: filterRaw === '' ? 'unknown' : filterRaw.toLowerCase(),
      tempC: Number(temp), expSec: Number(exp), night,
      size: fs.statSync(full).size,
    });
  }
  if (unparsed.length > 0)
    console.warn(`WARNING: ${unparsed.length} unparseable filenames (excluded):`, unparsed);
  markDuplicates(subs);
  return subs;
}

// ---- exact-duplicate detection --------------------------------------------
// Hash the PIXEL payload only, never the whole file: calibration stamps
// timestamps into the header, so byte-identical frames have differing file
// hashes. Found on M82 halpha (2026-08-08): ONE exposure present under EIGHT
// filenames, four of them with different DATE-OBS values, all eight integrated
// — ~10% of that stack was a single frame. Identical pixels cannot reject each
// other as outliers and they drag the mean, so this must be caught up front.
function pixelHash(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.toString('latin1', 0, 8) !== 'XISF0100') return null;
    const xml = Buffer.alloc(head.readUInt32LE(8));
    fs.readSync(fd, xml, 0, xml.length, 16);
    const m = xml.toString('utf8').match(/<Image\b[^>]*location="attachment:(\d+):(\d+)"/);
    if (!m) return null;
    const off = Number(m[1]), size = Number(m[2]);
    // Three spread slices: enough to identify an exact duplicate, ~16x cheaper
    // than hashing the whole frame.
    const hash = crypto.createHash('md5');
    const buf = Buffer.alloc(700 * 1024);
    for (const frac of [0.15, 0.5, 0.85]) {
      const n = fs.readSync(fd, buf, 0, buf.length, off + Math.floor(size * frac));
      hash.update(buf.subarray(0, n));
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function markDuplicates(subs) {
  const groups = new Map();
  for (const s of subs) {
    const h = pixelHash(s.path);
    if (!h) continue;
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(s);
  }
  let redundant = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.name.localeCompare(b.name));
    console.warn(`DUPLICATE: ${g.length} frames share identical pixels — keeping ${g[0].name}`);
    for (const s of g.slice(1)) {
      s.dupOf = g[0].name;
      console.warn(`   dropping ${s.name}`);
      ++redundant;
    }
  }
  if (redundant > 0)
    console.warn(`${redundant} redundant duplicate frame(s) will be rejected`);
  return redundant;
}

// ---- measurement orchestration ----
function csvFor(filter) { return `${WORK}/measure_${filter}.csv`; }
function logFor(filter) { return `${WORK}/measure_${filter}.log`; }

function statusOf(filter) {
  try { return fs.readFileSync(logFor(filter) + '.status', 'utf8').trim(); }
  catch { return null; }
}
function statusMtime(filter) {
  try { return fs.statSync(logFor(filter) + '.status').mtimeMs; }
  catch { return null; }
}
function csvRowCount(filter) {
  try {
    const lines = fs.readFileSync(csvFor(filter), 'utf8').trim().split('\n');
    return Math.max(0, lines.length - 1);
  } catch { return 0; }
}

function launchPI(listPath, csvPath, logPath, probe) {
  const args = ['-n', '--automation-mode', '--no-splash',
    `-r=${MEASURE_SCRIPT},${listPath},${csvPath},${logPath}${probe ? ',probe' : ''}`,
    '--force-exit'];
  for (const a of args) if (a.includes('"')) throw new Error(`Bad arg: ${a}`);
  return spawn(PIX, args, {
    env: { ...process.env, TMP: SWAP, TEMP: SWAP },
    stdio: 'ignore', detached: false,
  });
}

async function runMeasurement(filter, group, { remeasure, probe }) {
  const listPath = `${WORK}/list_${filter}.txt`;
  const csvPath = csvFor(filter);
  const logPath = logFor(filter);
  fs.writeFileSync(listPath, group.map((s) => s.path).join('\n') + '\n');

  if (!remeasure && csvRowCount(filter) === group.length) {
    console.log(`[${filter}] measurement CSV complete (${group.length} rows) — skipping`);
    return;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; ++attempt) {
    for (const p of [csvPath, logPath, logPath + '.status'])
      fs.rmSync(p, { force: true });
    console.log(`[${filter}] launching PixInsight (attempt ${attempt + 1}, ${group.length} subs)`);
    const started = Date.now();
    const child = await withPiLaunchLock(async () => launchPI(listPath, csvPath, logPath, probe));

    let exited = false;
    child.on('exit', () => { exited = true; });

    let hung = false;
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const st = statusOf(filter);
      if (st?.startsWith('done')) {
        // give the instance a moment to shut down on --force-exit
        for (let w = 0; w < 24 && !exited; ++w) await new Promise((r) => setTimeout(r, 5000));
        break;
      }
      if (st === 'fatal') { console.error(`[${filter}] FATAL in PJSR — see ${logPath}`); break; }
      if (exited) break;
      const now = Date.now();
      const mt = statusMtime(filter);
      if (mt === null && now - started > FIRST_STATUS_TIMEOUT_MS) { hung = true; }
      else if (mt !== null && now - mt > STALE_STATUS_TIMEOUT_MS) { hung = true; }
      else if (now - started > ABSOLUTE_TIMEOUT_MS) { hung = true; }
      if (hung) {
        console.error(`[${filter}] instance hung (status=${st ?? 'none'}) — killing PID ${child.pid}`);
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        await new Promise((r) => setTimeout(r, 10_000));
        break;
      }
      const rows = csvRowCount(filter);
      console.log(`[${filter}] ${Math.round((now - started) / 60000)} min — status="${st ?? 'none'}", ${rows}/${group.length} rows`);
    }

    const rows = csvRowCount(filter);
    const st = statusOf(filter);
    if (st?.startsWith('done') && rows > 0) {
      if (rows < group.length)
        console.warn(`[${filter}] only ${rows}/${group.length} measured — unmeasured subs will not be selected (see log)`);
      console.log(`[${filter}] measurement complete: ${rows} rows in ${Math.round((Date.now() - started) / 60000)} min`);
      return;
    }
    console.error(`[${filter}] attempt ${attempt + 1} failed (status=${st ?? 'none'}, rows=${rows})`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`[${filter}] measurement failed after ${MAX_RETRIES + 1} attempts`);
}

// ---- load + join ----
function loadMeasurements(subs) {
  const byKey = new Map(subs.map((s) => [s.path.toLowerCase().replace(/\\/g, '/'), s]));
  const filters = [...new Set(subs.map((s) => s.filter))];
  let joined = 0;
  for (const f of filters) {
    let text;
    try { text = fs.readFileSync(csvFor(f), 'utf8'); } catch { continue; }
    const lines = text.trim().split('\n').slice(1);
    for (const line of lines) {
      const m = line.match(/^"(.*?)",(.*)$/);
      if (!m) continue;
      const key = m[1].toLowerCase().replace(/\\/g, '/');
      const sub = byKey.get(key);
      if (!sub) { console.warn(`CSV row for unknown sub: ${m[1]}`); continue; }
      const [fwhm, ecc, median, noise, stars, psfSignal, snr, spread,
        boxTL, boxTR, boxBL, boxBR, boxC] = m[2].split(',').map(Number);
      // Gradient = corner-only spread normalized by the SFS (pedestal-
      // corrected) sky median. The raw PJSR spread is unusable here: the
      // dataset mixes calibration pedestals (~0.0155 vs none), which only
      // changes the denominator, and the center box holds Tulip nebulosity,
      // which is signal, not gradient. Corner differences cancel any
      // constant pedestal.
      const corners = [boxTL, boxTR, boxBL, boxBR];
      const cornerSpread = (Math.max(...corners) - Math.min(...corners)) /
        Math.max(median, 1e-9);
      Object.assign(sub, {
        fwhm, ecc, median, noise, stars, psfSignal, snr,
        spread: cornerSpread, rawSpread: spread,
        boxes: [boxTL, boxTR, boxBL, boxBR, boxC],
        bgPerSec: median / sub.expSec,
      });
      ++joined;
    }
  }
  return joined;
}

// ---- robust stats ----
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function robustZ(xs) {
  const med = median(xs);
  let scale = 1.4826 * median(xs.map((x) => Math.abs(x - med)));
  if (scale === 0) {
    const s = [...xs].sort((a, b) => a - b);
    const q1 = s[Math.floor(s.length * 0.25)], q3 = s[Math.floor(s.length * 0.75)];
    scale = (q3 - q1) / 1.349;
  }
  return xs.map((x) => (scale === 0 ? 0 : (x - med) / scale));
}

// ---- selection ----
function selectFrames(group, cfg) {
  const measured = group.filter((s) => Number.isFinite(s.fwhm));
  const zEcc = robustZ(measured.map((s) => s.ecc));
  const zFwhm = robustZ(measured.map((s) => s.fwhm));
  const zStars = robustZ(measured.map((s) => s.stars));
  // Sky background is MULTIPLICATIVE (transparency, moon) and spans close to a
  // decade, so z-score it in LOG space. A linear z-score collapses when the
  // population is bimodal: on M82 halpha one night held 58 of 113 frames in a
  // tight cluster, the MAD shrank to that cluster's width, and every other
  // night — at a perfectly ordinary 2x the median — read as 3-6 sigma. The cut
  // inverted and discarded the frames with 5x BETTER PSF signal weight.
  // In log space a 2x-brighter sky is a modest deviation and a 6x one is not.
  const zBg = robustZ(measured.map((s) => Math.log(Math.max(s.bgPerSec, 1e-30))));
  const zGrad = robustZ(measured.map((s) => s.spread));
  // Absolute reference for the background gate below.
  const medBg = median(measured.map((s) => s.bgPerSec));

  for (let i = 0; i < measured.length; ++i) {
    const s = measured[i];
    s.z = { ecc: zEcc[i], fwhm: zFwhm[i], stars: zStars[i], bg: zBg[i], grad: zGrad[i] };
    s.reasons = [];
    s.borderline = [];
    // The last element is an absolute guard that must ALSO hold before the
    // z-score is allowed to reject. Only the background test needs one:
    // narrowband sky sits near zero, so the MAD is tiny and ordinary
    // night-to-night variation reads as 3-6 sigma. Measured on M82 halpha
    // (2026-08-08): one night held 58 of 113 frames at bg/s 1.72e-6, which
    // made every other night an "outlier" at a perfectly normal 3-8e-6 — the
    // cut inverted, discarding frames whose PSF signal weight was 5x BETTER
    // than the ones it kept. Requiring real absolute brightness as well means
    // genuine moon/glow still fails both conditions, while a frame that is
    // merely above a freakishly tight median does not.
    const checks = [
      ['ecc', zEcc[i], cfg.sigmaEcc, +1, 'elongated stars', true],
      ['fwhm', zFwhm[i], cfg.sigmaFwhm, +1, 'bloated stars/seeing', true],
      ['stars', zStars[i], -cfg.sigmaStars, -1, 'low star count (clouds)', true],
      ['bg', zBg[i], cfg.sigmaBg, +1, 'high sky background (moon/glow)',
        s.bgPerSec > cfg.bgRatio * medBg],
      ['grad', zGrad[i], cfg.sigmaGrad, +1, 'strong gradient', true],
    ];
    for (const [key, z, thr, dir, label, guard] of checks) {
      const tripsZ = dir > 0 ? z > thr : z < thr;
      if (tripsZ && guard)
        s.reasons.push(`${label} (z=${z.toFixed(2)})`);
      else if (tripsZ)
        // Statistically extreme but not absolutely bad — kept, and surfaced so
        // a systematically odd filter is visible rather than silent.
        s.borderline.push(`${key}-z-only`);
      else if (dir > 0 ? z > thr - 0.5 : z < thr + 0.5) s.borderline.push(key);
    }
    if (s.ecc > cfg.eccCap) s.reasons.push(`ecc ${s.ecc.toFixed(3)} > cap ${cfg.eccCap}`);
    s.keep = s.reasons.length === 0;
  }
  for (const s of group) {
    if (!Number.isFinite(s.fwhm)) {
      s.keep = false;
      s.reasons = ['unmeasured (read/measure failure)'];
      s.borderline = [];
      s.z = {};
    }
  }
  // Exact duplicates are rejected regardless of how good they measure — the
  // frame is kept once, under its first name.
  for (const s of group) {
    if (s.dupOf) {
      s.keep = false;
      s.reasons = [`exact duplicate of ${s.dupOf}`];
      s.borderline = [];
    }
  }

  // Safety rail: never gut a filter. Duplicates are excluded from the pool —
  // un-rejecting one would put the same pixels back into the stack twice,
  // which is never the lesser evil.
  const rejected = measured.filter((s) => !s.keep && !s.dupOf);
  const maxRej = Math.floor(group.length * cfg.maxReject);
  if (rejected.length > maxRej) {
    console.warn(`[${group[0].filter}] WARNING: ${rejected.length}/${group.length} rejected exceeds cap ${maxRej} — un-rejecting least-bad`);
    rejected.sort((a, b) =>
      a.reasons.length - b.reasons.length ||
      maxAbsZ(a) - maxAbsZ(b));
    for (const s of rejected.slice(0, rejected.length - maxRej)) {
      s.keep = true;
      s.borderline.push('un-rejected by max-reject cap');
    }
  }
  return group;
}
function maxAbsZ(s) {
  return Math.max(...Object.values(s.z).map((z) => Math.abs(z ?? 0)), 0);
}

// ---- reports ----
function pct(n, d) { return d === 0 ? '-' : `${Math.round((n / d) * 100)}%`; }
function med3(xs) { return xs.length ? median(xs).toPrecision(3) : '-'; }

function writeReports(subs, cfg, copiedFilters) {
  const csvLines = ['name,filter,night,expSec,tempC,fwhmPx,eccentricity,starCount,bgPerSec,gradientSpread,psfSignalWeight,zEcc,zFwhm,zStars,zBg,zGrad,decision,borderline,reasons'];
  for (const s of subs) {
    csvLines.push([
      s.name, s.filter, s.night, s.expSec, s.tempC,
      s.fwhm?.toPrecision(5) ?? '', s.ecc?.toPrecision(5) ?? '', s.stars ?? '',
      s.bgPerSec?.toExponential(4) ?? '', s.spread?.toPrecision(5) ?? '',
      s.psfSignal?.toPrecision(5) ?? '',
      ...['ecc', 'fwhm', 'stars', 'bg', 'grad'].map((k) => s.z?.[k]?.toFixed(2) ?? ''),
      s.keep ? 'KEEP' : 'REJECT',
      s.borderline.join(';'),
      `"${s.reasons.join('; ')}"`,
    ].join(','));
  }
  fs.writeFileSync(`${WORK}/selection-report.csv`, csvLines.join('\n') + '\n');

  const md = [];
  md.push(`# Sub selection report — ${LABEL}`, '');
  md.push(`Source: \`${SRC}\` → Destination: \`${DEST}\``);
  md.push(`Thresholds: ecc z>${cfg.sigmaEcc} or >${cfg.eccCap} abs; fwhm z>${cfg.sigmaFwhm}; stars z<-${cfg.sigmaStars}; bg/s z>${cfg.sigmaBg}; gradient z>${cfg.sigmaGrad}; max-reject ${cfg.maxReject}`, '');

  const filters = [...new Set(subs.map((s) => s.filter))].sort();
  md.push('## Per-filter summary', '');
  md.push('| filter | subs | kept | rejected | kept time (h) | copied |');
  md.push('|---|---|---|---|---|---|');
  for (const f of filters) {
    const g = subs.filter((s) => s.filter === f);
    const kept = g.filter((s) => s.keep);
    const hrs = (kept.reduce((a, s) => a + s.expSec, 0) / 3600).toFixed(1);
    md.push(`| ${f} | ${g.length} | ${kept.length} (${pct(kept.length, g.length)}) | ${g.length - kept.length} | ${hrs} | ${copiedFilters.includes(f) ? 'yes' : 'no'} |`);
  }

  md.push('', '## Rejection reasons', '');
  const hist = new Map();
  for (const s of subs.filter((s) => !s.keep))
    for (const r of s.reasons) {
      const k = r.replace(/ \(z=.*\)| [\d.]+ > cap.*/, '');
      hist.set(k, (hist.get(k) ?? 0) + 1);
    }
  for (const [k, n] of [...hist].sort((a, b) => b[1] - a[1])) md.push(`- ${k}: ${n}`);

  md.push('', '## Per-night', '');
  md.push('| night | filter | total | kept | med FWHM | med ecc | med bg/s | med grad | temp °C |');
  md.push('|---|---|---|---|---|---|---|---|---|');
  const nights = [...new Set(subs.map((s) => s.night))].sort();
  for (const n of nights)
    for (const f of filters) {
      const g = subs.filter((s) => s.night === n && s.filter === f);
      if (g.length === 0) continue;
      const meas = g.filter((s) => Number.isFinite(s.fwhm));
      const temps = g.map((s) => s.tempC);
      md.push(`| ${n} | ${f} | ${g.length} | ${g.filter((s) => s.keep).length} | ${med3(meas.map((s) => s.fwhm))} | ${med3(meas.map((s) => s.ecc))} | ${meas.length ? median(meas.map((s) => s.bgPerSec)).toExponential(2) : '-'} | ${med3(meas.map((s) => s.spread))} | ${Math.min(...temps).toFixed(0)}..${Math.max(...temps).toFixed(0)} |`);
    }

  // sanity: rejected subs with top-decile PSF signal weight
  md.push('', '## Cross-checks', '');
  // PSF Signal Weight is an ABSOLUTE signal measure, so it scales with
  // exposure — a 600s sub outranks a 60s sub by ~an order of magnitude no
  // matter how bad it is. Comparing kept vs rejected across a mixed-exposure
  // filter therefore says nothing: it just reports which tier got culled more.
  // (M82 halpha read as "inverted" purely from keeping 90% of 60s and 53% of
  // 600s.) Compare WITHIN each exposure tier.
  md.push('_PSF signal weight compared within exposure tiers — it scales with exposure ' +
          'length, so cross-tier comparison is meaningless._', '');
  for (const f of filters) {
    const all = subs.filter((s) => s.filter === f && Number.isFinite(s.psfSignal));
    if (all.length < 10) continue;
    for (const exp of [...new Set(all.map((s) => s.expSec))].sort((a, b) => a - b)) {
      const g = all.filter((s) => s.expSec === exp);
      if (g.length < 10) continue;
      const sorted = [...g].sort((a, b) => b.psfSignal - a.psfSignal);
      const topDecile = new Set(sorted.slice(0, Math.ceil(g.length / 10)));
      for (const s of g.filter((s) => !s.keep && topDecile.has(s)))
        md.push(`- SUSPICIOUS: ${s.name} rejected (${s.reasons.join('; ')}) but has top-decile PSF signal weight for its ${exp}s tier`);
      const keptMed = median(g.filter((s) => s.keep).map((s) => s.psfSignal));
      const rejMed = median(g.filter((s) => !s.keep).map((s) => s.psfSignal));
      const flag = (Number.isFinite(rejMed) && Number.isFinite(keptMed) && rejMed > keptMed)
        ? '   <-- INVERTED, investigate' : '';
      md.push(`- ${f} ${exp}s (n=${g.length}, kept ${g.filter((s) => s.keep).length}): ` +
        `median PSF signal weight kept=${keptMed?.toPrecision(3)} vs rejected=` +
        `${Number.isFinite(rejMed) ? rejMed.toPrecision(3) : 'n/a'}${flag}`);
    }
  }

  md.push('', '## Spot-check candidates (blink these in the PI GUI)', '');
  for (const f of filters) {
    const meas = subs.filter((s) => s.filter === f && Number.isFinite(s.fwhm));
    const byGrad = [...meas].sort((a, b) => b.spread - a.spread);
    const byEcc = [...meas].sort((a, b) => b.ecc - a.ecc);
    md.push(`- ${f} worst gradient: ${byGrad.slice(0, 3).map((s) => s.name).join(', ')}`);
    md.push(`- ${f} worst ecc: ${byEcc.slice(0, 3).map((s) => s.name).join(', ')}`);
  }
  fs.writeFileSync(`${WORK}/selection-report.md`, md.join('\n') + '\n');
  return md.join('\n');
}

// ---- copy ----
function copyWinners(subs, copiedFilters) {
  fs.mkdirSync(DEST, { recursive: true });
  let copied = 0;
  for (const s of subs) {
    if (!s.keep || !copiedFilters.includes(s.filter)) continue;
    const dst = `${DEST}/${s.name}`;
    if (fs.existsSync(dst) && fs.statSync(dst).size === s.size) { ++copied; continue; }
    fs.copyFileSync(s.path, dst);
    if (fs.statSync(dst).size !== s.size)
      throw new Error(`Size mismatch after copy: ${dst}`);
    ++copied;
  }
  return copied;
}

// ---- main ----
async function main() {
  const cfg = parseArgs(process.argv);
  fs.mkdirSync(WORK, { recursive: true });
  const subs = enumerate();
  console.log(`Enumerated ${subs.length} subs`);

  if (cfg.probe) {
    // Probe the most populous filter — no dataset-specific name.
    const counts = new Map();
    for (const s of subs) counts.set(s.filter, (counts.get(s.filter) ?? 0) + 1);
    const probeFilter = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    console.log(`Probing filter "${probeFilter}"`);
    const probeGroup = subs.filter((s) => s.filter === probeFilter).slice(0, 3);
    await runMeasurement('probe', probeGroup, { remeasure: true, probe: true });
    console.log(`Probe done — inspect ${logFor('probe')} for PROBE lines and ${csvFor('probe')}`);
    return;
  }

  const allFilters = [...new Set(subs.map((s) => s.filter))];
  const toMeasure = (cfg.filters ?? allFilters);
  for (const f of toMeasure) {
    const group = subs.filter((s) => s.filter === f);
    if (group.length === 0) { console.warn(`No subs for filter ${f}`); continue; }
    await runMeasurement(f, group, { remeasure: cfg.remeasure, probe: false });
  }

  const joined = loadMeasurements(subs);
  console.log(`Joined ${joined} measurements`);

  for (const f of allFilters) {
    const group = subs.filter((s) => s.filter === f);
    if (group.some((s) => Number.isFinite(s.fwhm))) selectFrames(group, cfg);
    else group.forEach((s) => { s.keep = false; s.reasons = ['not measured']; s.borderline = []; s.z = {}; });
  }

  // Copy every filter that was processed. Restrict with --filters; --include
  // adds filters back that --filters left out.
  const copiedFilters = [...new Set([...(cfg.filters ?? allFilters), ...cfg.include])];
  const report = writeReports(subs, cfg, cfg.dryRun ? [] : copiedFilters);
  console.log('\n' + report.split('\n').slice(0, 40).join('\n'));

  if (cfg.dryRun) {
    console.log(`\nDRY RUN — no files copied. Reports in ${WORK}`);
    return;
  }
  const copied = copyWinners(subs, copiedFilters);
  fs.copyFileSync(`${WORK}/selection-report.csv`, `${DEST}/selection-report.csv`);
  fs.copyFileSync(`${WORK}/selection-report.md`, `${DEST}/selection-report.md`);
  console.log(`\nCopied ${copied} subs to ${DEST} (+ reports)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
