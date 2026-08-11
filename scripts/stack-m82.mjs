// stack-m82.mjs — rebuild masters from calibrated frames: CosmeticCorrection →
// headless WBPP (register + local normalize + integrate + drizzle 2x) →
// per-filter drop shrink optimization → final DrizzleIntegration masters.
//
// Stacking only. Nothing here stretches, combines or edits anything.
//
// Named for M81/M82 because that is what it was built on, but every path and
// both tuning knobs are CLI-overridable, so it drives any target whose frames
// follow the standard naming. Sh2-101 and Bubble Nebula run through it too; see
// scripts/calibrate-nights.mjs for the calibration stage that feeds it.
//
// Run with the winget Node v24 binary (PATH node is v10 and dies on import):
//   node scripts/stack-m82.mjs --step cc
//   node scripts/stack-m82.mjs --step wbpp
//   node scripts/stack-m82.mjs --step optimize [--filters lum,red]
//   node scripts/stack-m82.mjs --step final
//   node scripts/stack-m82.mjs --step verify
//
// Another target, overriding every path (M82 defaults are baked in):
//   node scripts/stack-m82.mjs --step cc \
//     --src Z:/sh2101-restack/lights --cc-out Z:/sh2101-restack/lights-cc \
//     --work D:/Temp/sh2101-stack
//
// Every step is idempotent and judged by OUTPUT FILES, never by log activity or
// process liveness — a PJSR script rewriting its log over SMB can look frozen
// while it is actually completing.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PIX = 'C:/Program Files/PixInsight/bin/PixInsight.exe';
const WBPP_JS = 'C:/Program Files/PixInsight/src/scripts/BatchPreprocessing/WBPP.js';
const SWAP = 'D:\\Temp\\pixinsight-swap';

// Defaults describe the M82 run; every one is overridable so a rerun on a
// different input set (e.g. after sub selection) needs no code change.
//   --lights <dir>   frames WBPP stacks          (default: the CC output)
//   --wbpp-out <dir> WBPP output tree
//   --opt-out <dir>  drop-shrink search output
//   --masters <dir>  final masters
let SRC = 'Z:/M82/all-cropped-no-overscan';
let CC_OUT = 'Z:/M82/all-cc';
let LIGHTS = null;       // defaults to CC_OUT once the arguments are parsed
let WBPP_OUT = 'Z:/M82/claude-wbpp';
let OPT_OUT = 'Z:/M82/drizzle-optimizer/2026-08';
let MASTERS = 'Z:/M82/claude-masters';
let MIN_WEIGHT = 0.05;   // see wbppParams(); pass --min-weight 0 after sub selection
// Exposure tiers merged into one group per filter. 600 covers M82's 60/300/600s;
// the Sh2-101 and Bubble sets add a 900s O3 tier, so those runs pass 900.
let EXPOSURE_TOLERANCE = 600;
let WORK = 'D:/Temp/m82-stack';

// Filters this rig shoots. sourceSubs() requires every frame to carry one of
// these tokens: a frame with no filter in its name is a NoFilter capture (the
// wheel not reporting), and those have silently reached an integration before.
const FILTER_TOKENS = ['lum', 'red', 'green', 'blue', 'halpha', 'oxygen3', 'sulfur'];

const CC_SCRIPT = `${ROOT}/pjsr/stack/cosmetic-correct.js`.replace(/\\/g, '/');
const BUILDER_SCRIPT = `${ROOT}/pjsr/stack/wbpp-drizzle-builder.js`.replace(/\\/g, '/');
const OPT_SCRIPT = `${ROOT}/pjsr/stack/drizzle-optimize.js`.replace(/\\/g, '/');
const FINAL_SCRIPT = `${ROOT}/pjsr/stack/final-drizzle.js`.replace(/\\/g, '/');

const DRIZZLE_SCALE = 2;
const POLL_MS = 60_000;

// ---- launch mutex: instances starting in the same window race the instance
// slot and hang (pattern from pix-planetary/scripts/pi-lock.mjs) ----
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mins = (ms) => Math.round(ms / 60000);

function launch(args) {
  for (const a of args)
    if (a.includes('"')) throw new Error(`Bad arg (quote): ${a}`);
  return spawn(PIX, args, {
    env: { ...process.env, TMP: SWAP, TEMP: SWAP },
    stdio: 'ignore',
    detached: false,
  });
}

function runScriptArgs(scriptPath, scriptArgs) {
  const parts = [scriptPath, ...scriptArgs.map(String)];
  for (const p of parts)
    if (p.includes(',')) throw new Error(`Argument contains a comma (breaks -r=): ${p}`);
  return ['-n', '--automation-mode', '--no-splash', `-r=${parts.join(',')}`, '--force-exit'];
}

function statusOf(logPath) {
  try { return fs.readFileSync(`${logPath}.status`, 'utf8').trim(); } catch { return null; }
}
function statusMtime(logPath) {
  try { return fs.statSync(`${logPath}.status`).mtimeMs; } catch { return null; }
}
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function listFiles(d, pred) {
  try { return fs.readdirSync(d).filter(pred); } catch { return []; }
}

/**
 * Run one PixInsight instance and wait until `isDone()` reports completion.
 * Kills the instance when its heartbeat goes stale, and retries.
 */
async function runInstance({ label, args, logPath, isDone, progress,
                             firstStatusMs, staleMs, absoluteMs, retries = 2 }) {
  for (let attempt = 0; attempt <= retries; ++attempt) {
    if (isDone()) {
      console.log(`[${label}] already complete — skipping`);
      return true;
    }
    fs.rmSync(`${logPath}.status`, { force: true });
    console.log(`[${label}] launching PixInsight (attempt ${attempt + 1})`);
    const started = Date.now();
    const child = await withPiLaunchLock(async () => launch(args));

    let exited = false;
    child.on('exit', (code) => { exited = true; console.log(`[${label}] instance exited (code ${code})`); });

    for (;;) {
      await sleep(POLL_MS);
      const st = statusOf(logPath);
      if (st === 'fatal') { console.error(`[${label}] FATAL in PJSR — see ${logPath}`); break; }
      if (isDone()) {
        for (let w = 0; w < 24 && !exited; ++w) await sleep(5000);
        break;
      }
      if (exited) break;

      const now = Date.now();
      const mt = statusMtime(logPath);
      let hung = false;
      if (mt === null && now - started > firstStatusMs) hung = true;
      else if (mt !== null && now - mt > staleMs) hung = true;
      else if (now - started > absoluteMs) hung = true;

      if (hung) {
        console.error(`[${label}] instance hung (status=${st ?? 'none'}) — killing PID ${child.pid}`);
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        await sleep(10_000);
        break;
      }
      console.log(`[${label}] ${mins(now - started)} min — status="${st ?? 'none'}"${progress ? ` — ${progress()}` : ''}`);
    }

    if (isDone()) {
      console.log(`[${label}] complete in ${mins(Date.now() - started)} min`);
      return true;
    }
    console.error(`[${label}] attempt ${attempt + 1} did not complete (status=${statusOf(logPath) ?? 'none'})`);
    await sleep(5000);
  }
  return false;
}

// =====================================================================
// Step: CosmeticCorrection
// =====================================================================
function sourceSubs() {
  const names = listFiles(SRC, (f) => f.toLowerCase().endsWith('.xisf'));
  const filterRe = new RegExp(`_(${FILTER_TOKENS.join('|')})_`, 'i');
  const bad = names.filter((n) => !filterRe.test(n));
  if (bad.length > 0)
    throw new Error(`${bad.length} sub(s) in ${SRC} have no filter token — quarantine them first: ${bad.slice(0, 3).join(', ')}`);
  return names.map((n) => `${SRC}/${n}`);
}
const ccOutputFor = (p) => `${CC_OUT}/${path.basename(p).replace(/\.xisf$/i, '')}_cc.xisf`;

async function stepCC() {
  ensureDir(WORK);
  ensureDir(CC_OUT);
  const subs = sourceSubs();
  const listPath = `${WORK}/cc-list.txt`;
  const logPath = `${WORK}/cc.log`;
  fs.writeFileSync(listPath, subs.join('\n') + '\n');
  console.log(`CosmeticCorrection: ${subs.length} subs → ${CC_OUT}`);

  const done = () => subs.filter((s) => fs.existsSync(ccOutputFor(s))).length;
  const ok = await runInstance({
    label: 'cc',
    args: runScriptArgs(CC_SCRIPT, [listPath, CC_OUT, logPath]),
    logPath,
    isDone: () => done() === subs.length,
    progress: () => `${done()}/${subs.length} corrected`,
    firstStatusMs: 10 * 60_000,
    staleMs: 30 * 60_000,
    absoluteMs: 6 * 3600_000,
  });
  console.log(ok ? `CC complete: ${done()}/${subs.length}` : `CC INCOMPLETE: ${done()}/${subs.length}`);
  if (!ok) process.exitCode = 1;
}

// =====================================================================
// Step: WBPP
// =====================================================================
// Built lazily: the directories are CLI-overridable, so this cannot be a
// module-level constant evaluated before arguments are parsed.
const wbppParams = () => [
  'automationMode=true',
  `dir=${LIGHTS}`,
  `outputDirectory=${WBPP_OUT}`,
  // Trap: autoIntegrationMode defaults true and silently switches any group of
  // >=150 frames to FastIntegration, bypassing PSF weighting AND local
  // normalization. lum has 321 frames.
  'autoIntegrationMode=false',
  // Merge the exposure tiers into one group per filter.
  `lightExposureTolerancePost=${EXPOSURE_TOLERANCE}`,
  'subframeWeightingEnabled=true',
  // Frames are still WEIGHTED by PSF signal, but minWeight also drives WBPP's
  // own pre-registration frame REJECTION. When sub selection has already been
  // done deliberately (select-subs.mjs), leaving this at the 0.05 default makes
  // WBPP re-cull on a blunt composite metric and override that work — on M82 it
  // cut a further 96 of 626, taking halpha from 76 to 50. Pass --min-weight 0
  // after a selection pass; keep 0.05 when stacking an unselected set.
  `minWeight=${MIN_WEIGHT}`,
  'imageRegistration=true',
  'pixelInterpolation=10',
  // One global auto reference frame ⇒ all masters mutually co-registered.
  'bestFrameReferenceMethod=1',
  'localNormalization=true',
  'localNormalizationInteractiveMode=false',
  // Required headless, or a frame-selection dialog blocks forever.
  'frameSelectionInteractive=false',
  // Dan's canonical integration settings. rejection_4=3 is EXPLICIT Generalized
  // ESD: "Auto" picks linear-fit on big groups, and linear-fit leaks hot pixels
  // that repeat at the same sky position through dither gaps.
  'rejection_4=3',
  'ESD_Outliers_4=0.10',
  'ESD_Significance_4=0.05',
  'lightsLargeScaleRejectionHigh=true',
  'lightsLargeScaleRejectionLow=true',
  'generateRejectionMaps=false',
  'autocrop=true',
  'platesolve=true',
  'integrate=true',
  // Drizzle is per-group state with no CLI parameter.
  'usePipelineBuilderScript=true',
  `pipelineBuilderScriptFile=${BUILDER_SCRIPT}`,
];

function wbppMasters() {
  return listFiles(`${WBPP_OUT}/master`, (f) => /drizzle_2x\.xisf$/i.test(f));
}
function wbppRegisteredDirs() {
  try {
    return fs.readdirSync(`${WBPP_OUT}/registered`, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => listFiles(`${WBPP_OUT}/registered/${n}`, (f) => f.endsWith('.xdrz')).length > 0);
  } catch { return []; }
}

async function stepWBPP() {
  ensureDir(WORK);
  const ccCount = listFiles(LIGHTS, (f) => f.toLowerCase().endsWith('.xisf')).length;
  if (ccCount === 0)
    throw new Error(`no .xisf frames in ${LIGHTS}`);

  // A killed run leaves _r.* behind and a rerun writes _r_1.* beside it; anything
  // globbing *.xdrz then ingests both sets.
  if (fs.existsSync(WBPP_OUT) && fs.readdirSync(WBPP_OUT).length > 0)
    throw new Error(`${WBPP_OUT} is not empty — move it aside before rerunning (stale _r.* would collide)`);
  ensureDir(WBPP_OUT);

  const auditPath = `${WBPP_OUT}/logs/pipeline-builder-audit.txt`;
  const args = ['-n', '--automation-mode', '--no-splash',
    `-r=${[WBPP_JS, ...wbppParams()].join(',')}`, '--force-exit'];
  for (const p of wbppParams())
    if (p.split('=').length !== 2) throw new Error(`Malformed WBPP param: ${p}`);

  console.log(`WBPP: ${ccCount} frames → ${WBPP_OUT}`);
  console.log(args.join(' '));

  const started = Date.now();
  const child = await withPiLaunchLock(async () => launch(args));
  let exited = false;
  child.on('exit', (code) => { exited = true; console.log(`[wbpp] instance exited (code ${code})`); });

  // The builder writes its audit before any heavy work. If it threw, WBPP
  // silently falls back to a NON-DRIZZLE pipeline, and eight hours later you
  // have 1x masters — so verify, and kill the run if it never verifies.
  //
  // But do NOT latch on the first read: WBPP builds the pipeline more than
  // once, and the first pass runs before the POST groups exist, so it
  // legitimately reports zero drizzle groups. Re-read every poll and only give
  // up after the grace period.
  const BUILDER_GRACE_MS = 6 * 60_000;
  let builderVerified = false;

  for (;;) {
    await sleep(POLL_MS);

    if (!builderVerified && fs.existsSync(auditPath)) {
      const audit = fs.readFileSync(auditPath, 'utf8');
      if (/BUILDER-OK drizzleGroups=[1-9]/.test(audit)) {
        builderVerified = true;
        console.log('--- pipeline builder audit ---\n' + audit + '-----------------------------');
        const alertFile = `${WBPP_OUT}/logs/pipeline-builder-ALERT.txt`;
        if (fs.existsSync(alertFile))
          console.warn('[wbpp] ALERT file present:\n' + fs.readFileSync(alertFile, 'utf8'));
      }
    }
    if (!builderVerified && Date.now() - started > BUILDER_GRACE_MS) {
      console.error(`[wbpp] builder never reported drizzleGroups>=1 within ${BUILDER_GRACE_MS / 60000} min — killing the run`);
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      process.exitCode = 1;
      return;
    }

    const regDirs = wbppRegisteredDirs();
    const regCount = regDirs.reduce(
      (a, d) => a + listFiles(`${WBPP_OUT}/registered/${d}`, (f) => /_r\.xisf$/i.test(f)).length, 0);
    const masters = wbppMasters().length;
    console.log(`[wbpp] ${mins(Date.now() - started)} min — ${regCount}/${ccCount} registered, ` +
                `${regDirs.length} groups, ${masters} drizzle masters`);

    if (exited) break;
    if (Date.now() - started > 20 * 3600_000) {
      console.error('[wbpp] absolute timeout — killing');
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      break;
    }
  }

  const masters = wbppMasters();
  console.log(`WBPP finished in ${mins(Date.now() - started)} min — ${masters.length} drizzle masters:`);
  for (const m of masters) console.log('  ' + m);
  if (!builderVerified) console.warn('WARNING: builder never verified — drizzle may not have run');
  if (masters.length === 0) process.exitCode = 1;
}

// =====================================================================
// Step: drop shrink optimization
// =====================================================================
const filterOf = (dirName) => (dirName.match(/FILTER-([^_]+)/i)?.[1] ?? dirName).toLowerCase();
const optResultPath = (dirName) => `${OPT_OUT}/${filterOf(dirName)}-result.json`;

async function stepOptimize(only) {
  ensureDir(WORK);
  ensureDir(OPT_OUT);
  const dirs = wbppRegisteredDirs();
  if (dirs.length === 0) throw new Error(`No registered/*/ directories with .xdrz under ${WBPP_OUT}`);

  const todo = only ? dirs.filter((d) => only.includes(filterOf(d))) : dirs;
  console.log(`Drop shrink optimization over ${todo.length} filter(s): ${todo.map(filterOf).join(', ')}`);

  // Sequential, one instance per filter: PixInsight crashed after ~36
  // consecutive DrizzleIntegrations in a single instance.
  for (const dirName of todo) {
    const filter = filterOf(dirName);
    const logPath = `${WORK}/opt-${filter}.log`;
    const resultPath = optResultPath(dirName);
    const outDir = `${OPT_OUT}/${dirName}`;
    ensureDir(outDir);

    await runInstance({
      label: `opt:${filter}`,
      args: runScriptArgs(OPT_SCRIPT,
        [`${WBPP_OUT}/registered/${dirName}`, outDir, logPath, resultPath, DRIZZLE_SCALE]),
      logPath,
      isDone: () => fs.existsSync(resultPath),
      progress: () => `${listFiles(outDir, (f) => f.endsWith('.fits')).length} tests saved`,
      firstStatusMs: 30 * 60_000,
      staleMs: 90 * 60_000,
      absoluteMs: 10 * 3600_000,
    });

    // Copy the local log next to the results for the record.
    try { fs.copyFileSync(logPath, `${OPT_OUT}/${filter}.log`); } catch { /* best effort */ }
  }

  console.log('\n  filter      | drop shrink | note');
  console.log('  ------------|-------------|------------------------');
  for (const dirName of dirs) {
    const p = optResultPath(dirName);
    if (!fs.existsSync(p)) { console.log(`  ${filterOf(dirName).padEnd(11)} |      —      | NOT RUN`); continue; }
    const r = JSON.parse(fs.readFileSync(p, 'utf8'));
    const rec = r.recommended === null ? '  —  ' : r.recommended.toFixed(3);
    console.log(`  ${r.filter.padEnd(11)} |    ${rec}    | ${r.note || 'ok'}`);
  }
}

// =====================================================================
// Step: final masters
// =====================================================================
function wcsRefFor(dirName) {
  const filter = filterOf(dirName);
  const cands = listFiles(`${WBPP_OUT}/master`,
    (f) => /drizzle_2x\.xisf$/i.test(f) && new RegExp(`FILTER-${filter}_`, 'i').test(f));
  return cands.length > 0 ? `${WBPP_OUT}/master/${cands[0]}` : null;
}

async function stepFinal() {
  ensureDir(WORK);
  ensureDir(MASTERS);
  const dirs = wbppRegisteredDirs();
  const summary = [];

  for (const dirName of dirs) {
    const filter = filterOf(dirName);
    const resultPath = optResultPath(dirName);
    if (!fs.existsSync(resultPath)) {
      console.warn(`[final:${filter}] no optimizer result — skipping`);
      summary.push({ filter, dropShrink: null, note: 'no optimizer result' });
      continue;
    }
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    if (result.recommended === null) {
      console.warn(`[final:${filter}] optimizer found no clean value (${result.note}) — skipping`);
      summary.push({ filter, dropShrink: null, note: result.note });
      continue;
    }

    const ds = result.recommended;
    const tag = ds.toFixed(3).replace('.', '_');
    const outFull = `${MASTERS}/${filter}_drizzle2x_ds${tag}.xisf`;
    const outCrop = `${MASTERS}/${filter}_drizzle2x_ds${tag}_crop.xisf`;
    const wcsRef = wcsRefFor(dirName);
    if (!wcsRef) throw new Error(`No WBPP drizzle_2x master found for ${filter} — cannot transplant WCS`);
    const logPath = `${WORK}/final-${filter}.log`;

    await runInstance({
      label: `final:${filter}`,
      args: runScriptArgs(FINAL_SCRIPT,
        [`${WBPP_OUT}/registered/${dirName}`, ds, outFull, outCrop, wcsRef, logPath, DRIZZLE_SCALE]),
      logPath,
      isDone: () => fs.existsSync(outFull) && fs.existsSync(outCrop),
      firstStatusMs: 20 * 60_000,
      staleMs: 60 * 60_000,
      absoluteMs: 4 * 3600_000,
    });

    try { fs.copyFileSync(logPath, `${MASTERS}/${filter}.log`); } catch { /* best effort */ }
    summary.push({ filter, dropShrink: ds, note: fs.existsSync(outCrop) ? 'ok' : 'FAILED' });
  }

  console.log('\n  filter      | drop shrink | status');
  console.log('  ------------|-------------|--------');
  for (const s of summary)
    console.log(`  ${s.filter.padEnd(11)} |    ${s.dropShrink === null ? '  —  ' : s.dropShrink.toFixed(3)}    | ${s.note}`);
}

// =====================================================================
// Step: recrop — rebuild the cropped masters WITH a valid WCS
//
// Crop deletes the astrometric solution, so a cropped master can only get one
// by transplant from a reference of identical geometry: WBPP's own autocrop
// master. That forces us to crop to WBPP's rectangle. No re-integration
// needed — this operates on the saved full-frame masters.
// =====================================================================
const RECROP_SCRIPT = `${ROOT}/pjsr/stack/recrop-masters.js`.replace(/\\/g, '/');

function wbppMasterFor(filter, suffix) {
  const cands = listFiles(`${WBPP_OUT}/master`,
    (f) => f.endsWith(suffix) && new RegExp(`FILTER-${filter}_`, 'i').test(f));
  return cands.length > 0 ? `${WBPP_OUT}/master/${cands[0]}` : null;
}

async function stepRecrop() {
  ensureDir(WORK);
  const fulls = listFiles(MASTERS, (f) => /_drizzle2x_ds[0-9_]+\.xisf$/i.test(f));
  if (fulls.length === 0) throw new Error(`No full-frame masters in ${MASTERS}`);

  for (const full of fulls) {
    const filter = full.split('_')[0];
    const wbppFull = wbppMasterFor(filter, 'drizzle_2x.xisf');
    const wbppCrop = wbppMasterFor(filter, 'drizzle_2x_autocrop.xisf');
    if (!wbppFull || !wbppCrop) {
      console.warn(`[recrop:${filter}] missing WBPP reference masters — skipping`);
      continue;
    }
    const outPath = `${MASTERS}/${full.replace(/\.xisf$/i, '_crop.xisf')}`;
    const logPath = `${WORK}/recrop-${filter}.log`;
    fs.rmSync(outPath, { force: true });   // the old WCS-less crop

    await runInstance({
      label: `recrop:${filter}`,
      args: runScriptArgs(RECROP_SCRIPT,
        [wbppFull, wbppCrop, `${MASTERS}/${full}`, outPath, logPath]),
      logPath,
      isDone: () => fs.existsSync(outPath),
      firstStatusMs: 10 * 60_000,
      staleMs: 20 * 60_000,
      absoluteMs: 60 * 60_000,
      retries: 1,
    });
    try { fs.copyFileSync(logPath, `${MASTERS}/${filter}-recrop.log`); } catch { /* best effort */ }
  }
}

// =====================================================================
// Step: verify
// =====================================================================
function stepVerify() {
  const src = listFiles(SRC, (f) => f.toLowerCase().endsWith('.xisf')).length;
  const cc = listFiles(CC_OUT, (f) => f.toLowerCase().endsWith('.xisf')).length;
  console.log(`source subs:      ${src}`);
  console.log(`cosmetic-corrected: ${cc}`);
  for (const d of wbppRegisteredDirs()) {
    const r = listFiles(`${WBPP_OUT}/registered/${d}`, (f) => /_r\.xisf$/i.test(f)).length;
    const all = listFiles(`${WBPP_OUT}/registered/${d}`, (f) => f.endsWith('.xdrz'));
    const closed = all.filter((f) => {
      try { return fs.statSync(`${WBPP_OUT}/registered/${d}/${f}`).size >= 20 * 1024; } catch { return false; }
    }).length;
    console.log(`  ${filterOf(d).padEnd(8)} registered=${r}  xdrz=${all.length} (closed ${closed})`);
  }
  console.log(`WBPP drizzle masters: ${wbppMasters().length}`);
  const finals = listFiles(MASTERS, (f) => f.endsWith('.xisf'));
  console.log(`final masters: ${finals.length}`);
  for (const f of finals) console.log(`  ${f}  ${(fs.statSync(`${MASTERS}/${f}`).size / 1e6).toFixed(0)} MB`);
}

// =====================================================================
const argv = process.argv.slice(2);
let step = null;
let only = null;
for (let i = 0; i < argv.length; ++i) {
  if (argv[i] === '--step') step = argv[++i];
  else if (argv[i] === '--filters') only = argv[++i].split(',').map((s) => s.trim().toLowerCase());
  else if (argv[i] === '--src') SRC = argv[++i].replace(/\\/g, '/').replace(/\/+$/, '');
  else if (argv[i] === '--cc-out') CC_OUT = argv[++i].replace(/\\/g, '/').replace(/\/+$/, '');
  else if (argv[i] === '--lights') LIGHTS = argv[++i].replace(/\\/g, '/').replace(/\/+$/, '');
  else if (argv[i] === '--wbpp-out') WBPP_OUT = argv[++i].replace(/\\/g, '/').replace(/\/+$/, '');
  else if (argv[i] === '--opt-out') OPT_OUT = argv[++i].replace(/\\/g, '/').replace(/\/+$/, '');
  else if (argv[i] === '--masters') MASTERS = argv[++i].replace(/\\/g, '/').replace(/\/+$/, '');
  else if (argv[i] === '--work') WORK = argv[++i].replace(/\\/g, '/').replace(/\/+$/, '');
  else if (argv[i] === '--min-weight') MIN_WEIGHT = Number(argv[++i]);
  else if (argv[i] === '--exposure-tolerance') EXPOSURE_TOLERANCE = Number(argv[++i]);
  else throw new Error(`Unknown argument: ${argv[i]}`);
}

// Resolved after parsing so that --cc-out alone still feeds the WBPP step, and
// --lights can point it at a set that never went through CosmeticCorrection.
if (LIGHTS === null) LIGHTS = CC_OUT;

switch (step) {
  case 'cc': await stepCC(); break;
  case 'wbpp': await stepWBPP(); break;
  case 'optimize': await stepOptimize(only); break;
  case 'final': await stepFinal(); break;
  case 'recrop': await stepRecrop(); break;
  case 'verify': stepVerify(); break;
  default:
    console.error('usage: stack-m82.mjs --step cc|wbpp|optimize|final|recrop|verify [--filters lum,red]\n' +
      '  paths:  --src --cc-out --lights --wbpp-out --opt-out --masters --work\n' +
      '  tuning: --min-weight --exposure-tolerance');
    process.exitCode = 2;
}
