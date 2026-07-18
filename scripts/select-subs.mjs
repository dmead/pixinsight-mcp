// select-subs.mjs — measure calibrated subs headlessly, cull statistical
// outliers (star shape, seeing, clouds, sky background, per-sub gradient),
// copy winners to a destination folder, and write selection reports.
//
// Run with the winget Node v24 binary (PATH node is v10 and dies on import):
//   node scripts/select-subs.mjs [--dry-run] [--probe] [--remeasure]
//     [--filters halpha,sulfur] [--include lum,unknown]
//     [--sigma-ecc 2.5] [--sigma-fwhm 2.5] [--sigma-stars 2.5]
//     [--sigma-bg 3.0] [--sigma-grad 2.5] [--ecc-cap 0.60]
//     [--max-reject 0.35]
//
// Measurement is one headless PixInsight instance per filter, sequential.
// Completion is judged by output files (status file + CSV), never by log
// activity or process liveness.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PIX = 'C:/Program Files/PixInsight/bin/PixInsight.exe';
const SWAP = 'D:\\Temp\\pixinsight-swap';
const WORK = 'D:/Temp/sh2101-select';
const SRC = 'Z:/Sh2 101/all-calibrated-lights';
const DEST = 'Z:/Sh2 101/claude-lights';
const MEASURE_SCRIPT = path.join(ROOT, 'pjsr', 'measure-subs.js').replace(/\\/g, '/');

const MAIN_FILTERS = ['halpha', 'sulfur', 'oxygen3'];
const ODDBALL_FILTERS = ['lum', 'unknown'];

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
    eccCap: 0.72, maxReject: 0.35,
  };
  for (let i = 2; i < argv.length; ++i) {
    const a = argv[i];
    if (a === '--dry-run') cfg.dryRun = true;
    else if (a === '--probe') cfg.probe = true;
    else if (a === '--remeasure') cfg.remeasure = true;
    else if (a === '--filters') cfg.filters = argv[++i].split(',');
    else if (a === '--include') cfg.include = argv[++i].split(',');
    else if (a === '--sigma-ecc') cfg.sigmaEcc = Number(argv[++i]);
    else if (a === '--sigma-fwhm') cfg.sigmaFwhm = Number(argv[++i]);
    else if (a === '--sigma-stars') cfg.sigmaStars = Number(argv[++i]);
    else if (a === '--sigma-bg') cfg.sigmaBg = Number(argv[++i]);
    else if (a === '--sigma-grad') cfg.sigmaGrad = Number(argv[++i]);
    else if (a === '--ecc-cap') cfg.eccCap = Number(argv[++i]);
    else if (a === '--max-reject') cfg.maxReject = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return cfg;
}

// ---- enumeration ----
const NAME_RE = /^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})_([a-z0-9]*)_(-?\d+(?:\.\d+)?)_(\d+(?:\.\d+)?)s_(\d+)_c\.xisf$/i;

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
  return subs;
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
  const zBg = robustZ(measured.map((s) => s.bgPerSec));
  const zGrad = robustZ(measured.map((s) => s.spread));

  for (let i = 0; i < measured.length; ++i) {
    const s = measured[i];
    s.z = { ecc: zEcc[i], fwhm: zFwhm[i], stars: zStars[i], bg: zBg[i], grad: zGrad[i] };
    s.reasons = [];
    s.borderline = [];
    const checks = [
      ['ecc', zEcc[i], cfg.sigmaEcc, +1, 'elongated stars'],
      ['fwhm', zFwhm[i], cfg.sigmaFwhm, +1, 'bloated stars/seeing'],
      ['stars', zStars[i], -cfg.sigmaStars, -1, 'low star count (clouds)'],
      ['bg', zBg[i], cfg.sigmaBg, +1, 'high sky background (moon/glow)'],
      ['grad', zGrad[i], cfg.sigmaGrad, +1, 'strong gradient'],
    ];
    for (const [key, z, thr, dir, label] of checks) {
      if (dir > 0 ? z > thr : z < thr) s.reasons.push(`${label} (z=${z.toFixed(2)})`);
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

  // safety rail: never gut a filter
  const rejected = measured.filter((s) => !s.keep);
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
  md.push(`# Sub selection report — Sh2-101`, '');
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
  for (const f of filters) {
    const g = subs.filter((s) => s.filter === f && Number.isFinite(s.psfSignal));
    if (g.length < 10) continue;
    const sorted = [...g].sort((a, b) => b.psfSignal - a.psfSignal);
    const topDecile = new Set(sorted.slice(0, Math.ceil(g.length / 10)));
    const suspicious = g.filter((s) => !s.keep && topDecile.has(s));
    for (const s of suspicious)
      md.push(`- SUSPICIOUS: ${s.name} rejected (${s.reasons.join('; ')}) but has top-decile PSF signal weight`);
    const keptMed = median(g.filter((s) => s.keep).map((s) => s.psfSignal));
    const rejMed = median(g.filter((s) => !s.keep).map((s) => s.psfSignal));
    md.push(`- ${f}: median PSF signal weight kept=${keptMed?.toPrecision(3)} vs rejected=${Number.isFinite(rejMed) ? rejMed.toPrecision(3) : 'n/a'}`);
  }

  md.push('', '## Spot-check candidates (blink these in the PI GUI)', '');
  for (const f of filters.filter((f) => MAIN_FILTERS.includes(f))) {
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
    const probeGroup = subs.filter((s) => s.filter === 'halpha').slice(0, 3);
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

  const copiedFilters = [...MAIN_FILTERS, ...cfg.include];
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
