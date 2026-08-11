// calibrate-nights.mjs — calibrate the night folders that are missing from a
// target's calibrated-lights pool, then assemble the pool the restack reads.
//
//   node scripts/calibrate-nights.mjs --target sh2101 --step plan
//   node scripts/calibrate-nights.mjs --target sh2101 --step calibrate
//   node scripts/calibrate-nights.mjs --target sh2101 --step pool
//   node scripts/calibrate-nights.mjs --target sh2101 --step audit
//
// Calibration is bias + flat only. There is no dark library for this camera at
// gain 60, and none at all beyond 180/300 s gain 0, so hot pixels are handled
// downstream by CosmeticCorrection (auto 3-sigma) rather than by dark
// subtraction — the same choice the existing masters were built with.
//
// Every step is idempotent and judged by OUTPUT FILES.
//
// Run with the winget Node v24 binary; the `node` on PATH is v10.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ensureDir, listFiles, mins, runInstance, wbppArgs, walkFiles,
} from './lib/pi-runner.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CAL_BUILDER = `${ROOT}/pjsr/stack/wbpp-calibration-builder.js`.replace(/\\/g, '/');

const BIAS_60 = 'D:/telescope_data/biases/qhy533m/04-07-2026-gain-60/masterBias_BIN-1_3008x3028.xisf';
const BIAS_00 = 'D:/telescope_data/biases/qhy533m/01-10-2026-gain-0/masterBias_BIN-1_3008x3028.xisf';
const FLATS_D = 'D:/telescope_data/flats-triplet';
const FLATS_Y = 'Y:/flats-triplet';

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------
// `groups` are calibration runs. Nights that share one bias AND one flat set
// are batched so a 1200-frame flat set is only integrated once.
//
// Flat assignment is nearest-available-night, per the 2026-07-21 audit finding
// that week-scale flat drift is real (0.2-0.7% corner deviation between flat
// sets a week apart). Where a flat folder still holds its raw frames WBPP
// integrates them; where only the built master survives, that master is fed
// directly (`detectMasterIncludingFullPath` matches the `masterFlat_` prefix).
const TARGETS = {
  sh2101: {
    lightsRoot: 'Z:/Sh2 101',
    // Output roots deliberately contain NO SPACE: StarAlignment fails on
    // spaced output paths, and this tree feeds the registration run.
    work: 'Z:/sh2101-restack',
    // Existing calibrated frames, lowest precedence first. Later entries win on
    // basename collision, so the repaired "-fixed" set supersedes the original
    // for the nights it covers, and freshly calibrated frames supersede both.
    existingPools: [
      'Z:/Sh2 101/all-calibrated-lights',
      'Z:/Sh2 101/all-calibrated-lights-fixed',
    ],
    groups: [
      {
        id: '2026-07-25', nights: ['2026-07-25'], bias: BIAS_60,
        flats: [`${FLATS_D}/2026-07-26/FLAT`],
        note: 'next-night flats, full 6-filter raw set',
      },
      {
        id: '2026-07-31', nights: ['2026-07-31'], bias: BIAS_60,
        flats: [`${FLATS_D}/2026-07-31/FLAT`, `${FLATS_D}/2026-08-01/FLAT`],
        note: 'same-night Ha/S2 flats; the O3 flats are split across 07-31 (19) and 08-01 (181)',
      },
      {
        id: '2026-08', nights: ['2026-08-03', '2026-08-08', '2026-08-09'], bias: BIAS_60,
        flats: [`${FLATS_D}/2026-08-10/FLAT`],
        note: 'nearest complete 6-filter set, and the only one matching the -5C sensor temperature',
      },
    ],
  },

  bubble: {
    lightsRoot: 'Y:/BubbleNebula',
    work: 'Y:/BubbleNebula/restack-2026-08',
    existingPools: ['Y:/BubbleNebula/all-calibrated-lights'],
    groups: [
      {
        id: '2025-11-04', nights: ['2025-11-04'], bias: BIAS_00,
        flats: [`${FLATS_Y}/2025-11-04/masters`],
        note: 'gain 0 era; exact-night master flat (raw flats no longer on disk)',
      },
      {
        id: '2025-11-27', nights: ['2025-11-27'], bias: BIAS_00,
        flats: [`${FLATS_Y}/2025-11-27/MASTERS`],
        note: 'gain 0 era; exact-night master flats',
      },
      {
        id: '2026-07-25', nights: ['2026-07-25'], bias: BIAS_60,
        flats: [`${FLATS_D}/2026-07-26/FLAT`],
        note: 'gain 60 era begins here',
      },
      {
        id: '2026-08-09', nights: ['2026-08-09'], bias: BIAS_60,
        flats: [`${FLATS_D}/2026-08-10/FLAT`],
        note: 'gain 60; next-night flats, full raw set',
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const cfg = { target: null, step: 'plan', only: null };
  for (let i = 2; i < argv.length; ++i) {
    const a = argv[i];
    if (a === '--target') cfg.target = argv[++i];
    else if (a === '--step') cfg.step = argv[++i];
    else if (a === '--only') cfg.only = argv[++i].split(',');
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!cfg.target || !TARGETS[cfg.target])
    throw new Error(`--target must be one of: ${Object.keys(TARGETS).join(', ')}`);
  return cfg;
}

const cfg = parseArgs(process.argv);
const T = TARGETS[cfg.target];
const groups = cfg.only ? T.groups.filter((g) => cfg.only.includes(g.id)) : T.groups;
const CAL_ROOT = `${T.work}/calibration`;
const POOL = `${T.work}/lights`;

const isLight = (n) => /\.(fits?|xisf)$/i.test(n);
const lightsOfNight = (night) => {
  const dir = `${T.lightsRoot}/${night}/LIGHT`;
  return listFiles(dir, isLight).sort().map((n) => `${dir}/${n}`);
};

/** Calibrated frames WBPP wrote for a group, wherever it filed them. */
const calibratedOf = (groupId) =>
  walkFiles(`${CAL_ROOT}/${groupId}/calibrated`, (n) => /_c\.xisf$/i.test(n));

// ---------------------------------------------------------------------------
// Step: plan
// ---------------------------------------------------------------------------
function stepPlan() {
  console.log(`target ${cfg.target}: ${T.lightsRoot}`);
  console.log(`  pool  -> ${POOL}`);
  let total = 0;
  for (const g of groups) {
    const lights = g.nights.flatMap(lightsOfNight);
    total += lights.length;
    console.log(`\n  [${g.id}] ${lights.length} light(s) from ${g.nights.join(', ')}`);
    console.log(`     bias  ${g.bias}${fs.existsSync(g.bias) ? '' : '   *** MISSING ***'}`);
    for (const f of g.flats) {
      const n = walkFiles(f, (x) => /\.(fits?|xisf)$/i.test(x)).length;
      console.log(`     flats ${f}  (${n} frame(s))${n ? '' : '   *** EMPTY ***'}`);
    }
    console.log(`     note  ${g.note}`);
    const done = calibratedOf(g.id).length;
    if (done) console.log(`     already calibrated: ${done}`);
  }
  console.log(`\n  ${total} light frame(s) to calibrate across ${groups.length} run(s)`);

  const existing = poolSources();
  console.log(`\n  existing calibrated frames available for the pool:`);
  for (const [dir, files] of existing) console.log(`     ${dir}  ${files.length}`);
}

// ---------------------------------------------------------------------------
// Step: calibrate
// ---------------------------------------------------------------------------
function calParams(g, outDir) {
  const params = [
    'automationMode=true',
    `outputDirectory=${outDir}`,
    // Calibration only. There is no `calibrate` switch — calibration is
    // implicit, and turning the later stages off is what stops the run there.
    'imageRegistration=false',
    'integrate=false',
    'platesolve=false',
    'autocrop=false',
    'subframeWeightingEnabled=false',
    'frameSelectionEnabled=false',
    'frameSelectionInteractive=false',
    'localNormalization=false',
    'localNormalizationInteractiveMode=false',
    'generateRejectionMaps=false',
    // Master frames are recognised by the `master...` filename prefix.
    'detectMasterIncludingFullPath=true',
    // Flat integration only; large-scale rejection guards against a satellite
    // or aircraft trail in a sky flat.
    'flatsLargeScaleRejection=true',
    // Disable cosmetic correction and assert the group inventory.
    'usePipelineBuilderScript=true',
    `pipelineBuilderScriptFile=${CAL_BUILDER}`,
  ];
  for (const f of g.flats) params.push(`dir=${f}`);
  params.push(`file=${g.bias}`);
  for (const l of g.nights.flatMap(lightsOfNight)) params.push(`file=${l}`);
  return params;
}

async function stepCalibrate() {
  ensureDir(CAL_ROOT);
  for (const g of groups) {
    const outDir = `${CAL_ROOT}/${g.id}`;
    const lights = g.nights.flatMap(lightsOfNight);
    if (lights.length === 0) {
      console.log(`[${g.id}] no lights — skipping`);
      continue;
    }
    if (calibratedOf(g.id).length >= lights.length) {
      console.log(`[${g.id}] already calibrated (${calibratedOf(g.id).length}/${lights.length}) — skipping`);
      continue;
    }
    // A killed run leaves partial output that a rerun writes _1 copies beside.
    if (fs.existsSync(outDir) && calibratedOf(g.id).length > 0)
      throw new Error(`${outDir} holds a partial run — move it aside before rerunning`);
    ensureDir(outDir);

    const auditPath = `${outDir}/logs/calibration-builder-audit.txt`;
    const alertPath = `${outDir}/logs/calibration-builder-ALERT.txt`;
    const args = wbppArgs(calParams(g, outDir));

    // The command line is one argv element; Windows caps it at ~32k chars.
    const cmdLen = args.join(' ').length;
    if (cmdLen > 30000)
      throw new Error(`[${g.id}] command line is ${cmdLen} chars — split the group`);

    console.log(`\n[${g.id}] calibrating ${lights.length} light(s) -> ${outDir}  (cmd ${cmdLen} chars)`);
    console.log(`[${g.id}] ${g.note}`);

    let builderSeen = false;
    const ok = await runInstance({
      label: g.id,
      args,
      isDone: () => calibratedOf(g.id).length >= lights.length,
      progress: () => `${calibratedOf(g.id).length}/${lights.length} calibrated`,
      // If the builder throws, WBPP swallows it, falls back to its default
      // pipeline and silently re-enables cosmetic correction. Verify it ran.
      verify: (elapsed) => {
        if (!builderSeen && fs.existsSync(auditPath)) {
          const audit = fs.readFileSync(auditPath, 'utf8');
          if (/BUILDER-OK /.test(audit)) {
            builderSeen = true;
            console.log(`--- [${g.id}] calibration builder audit ---\n${audit}------------------------------`);
            if (fs.existsSync(alertPath))
              console.warn(`[${g.id}] ALERT:\n${fs.readFileSync(alertPath, 'utf8')}`);
          }
        }
        if (!builderSeen && elapsed > 15 * 60_000)
          return 'calibration builder never reported BUILDER-OK within 15 min';
        return null;
      },
      absoluteMs: 8 * 3600_000,
    });
    if (!ok) {
      console.error(`[${g.id}] calibration INCOMPLETE — stopping`);
      process.exitCode = 1;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Step: pool
// ---------------------------------------------------------------------------
// The restack reads ONE directory. Assemble it by basename with explicit
// precedence rather than dumping every source together: the "-fixed" pool
// re-calibrates nights that the main pool also holds, and this run
// re-calibrates nights both of them hold.
function poolSources() {
  const out = [];
  for (const dir of T.existingPools)
    out.push([dir, listFiles(dir, (n) => /\.xisf$/i.test(n)).map((n) => `${dir}/${n}`)]);
  for (const g of T.groups) {
    const files = calibratedOf(g.id);
    if (files.length) out.push([`${CAL_ROOT}/${g.id}`, files]);
  }
  return out;
}

/** Nights this run recalibrates, as the date prefixes their frames carry. */
function recalibratedPrefixes() {
  const prefixes = new Set();
  for (const g of T.groups)
    for (const night of g.nights)
      for (const f of lightsOfNight(night)) {
        const m = path.basename(f).match(/^(\d{4}-\d{2}-\d{2})/);
        if (m) prefixes.add(m[1]);
      }
  return prefixes;
}

function stepPool() {
  ensureDir(POOL);
  const recal = recalibratedPrefixes();
  const chosen = new Map();   // basename -> source path
  const superseded = [];

  for (const [dir, files] of poolSources()) {
    const isFresh = dir.startsWith(CAL_ROOT);
    for (const f of files) {
      const base = path.basename(f);
      // A frame from an old pool whose night we just recalibrated is stale even
      // if the fresh run named it differently (e.g. it was never pooled before).
      const night = base.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
      if (!isFresh && night && recal.has(night)) {
        superseded.push(`${base}  (night ${night} recalibrated)`);
        continue;
      }
      if (chosen.has(base)) superseded.push(`${base}  (superseded by ${dir})`);
      chosen.set(base, f);
    }
  }

  console.log(`pool: ${chosen.size} frame(s) -> ${POOL}`);
  if (superseded.length)
    console.log(`  ${superseded.length} frame(s) dropped as superseded/stale`);

  let copied = 0, present = 0;
  for (const [base, src] of chosen) {
    const dst = `${POOL}/${base}`;
    if (fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size) { ++present; continue; }
    fs.copyFileSync(src, dst);
    if (fs.statSync(dst).size !== fs.statSync(src).size)
      throw new Error(`short copy: ${dst}`);
    if (++copied % 25 === 0) console.log(`  ${copied} copied ...`);
  }
  console.log(`pool ready: ${copied} copied, ${present} already present, ${chosen.size} total`);

  const byFilter = {};
  for (const base of chosen.keys()) {
    const m = base.match(/_([a-z0-9]+)_-?[\d.]+_([\d.]+)s_/i);
    const k = m ? `${m[1]} ${m[2]}s` : 'unmatched';
    byFilter[k] = (byFilter[k] || 0) + 1;
  }
  for (const k of Object.keys(byFilter).sort()) console.log(`  ${k.padEnd(18)} ${byFilter[k]}`);

  fs.writeFileSync(`${T.work}/pool-manifest.txt`,
    [...chosen].map(([b, s]) => `${b}\t${s}`).join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Step: audit
// ---------------------------------------------------------------------------
// Proves each freshly calibrated frame really was bias- and flat-corrected, by
// reading the calibration provenance WBPP stamps into the XISF header. A frame
// that silently missed its flat is the failure this whole script exists to
// avoid, and it is invisible until the stack is stretched.
function xisfKeywords(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.toString('latin1', 0, 8) !== 'XISF0100') return null;
    const xml = Buffer.alloc(head.readUInt32LE(8));
    fs.readSync(fd, xml, 0, xml.length, 16);
    return xml.toString('utf8');
  } finally { fs.closeSync(fd); }
}

function stepAudit() {
  let bad = 0, checked = 0;
  for (const g of T.groups) {
    const files = calibratedOf(g.id);
    if (!files.length) continue;
    const missingFlat = [], missingBias = [];
    for (const f of files) {
      const xml = xisfKeywords(f);
      ++checked;
      if (!xml) { ++bad; console.warn(`  unreadable: ${f}`); continue; }
      if (!/masterFlat|FLATIMG|flatFrame/i.test(xml)) missingFlat.push(path.basename(f));
      if (!/masterBias|BIASIMG|biasFrame/i.test(xml)) missingBias.push(path.basename(f));
    }
    console.log(`[${g.id}] ${files.length} calibrated`);
    if (missingFlat.length) {
      console.warn(`   NO FLAT provenance on ${missingFlat.length}: ${missingFlat.slice(0, 5).join(', ')}`);
      bad += missingFlat.length;
    }
    if (missingBias.length) {
      console.warn(`   NO BIAS provenance on ${missingBias.length}: ${missingBias.slice(0, 5).join(', ')}`);
      bad += missingBias.length;
    }
    if (!missingFlat.length && !missingBias.length)
      console.log(`   bias + flat provenance present on all frames`);
  }
  console.log(`\naudited ${checked} frame(s), ${bad} problem(s)`);
  if (bad) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
const started = Date.now();
switch (cfg.step) {
  case 'plan': stepPlan(); break;
  case 'calibrate': await stepCalibrate(); break;
  case 'pool': stepPool(); break;
  case 'audit': stepAudit(); break;
  default: throw new Error(`Unknown --step ${cfg.step} (plan|calibrate|pool|audit)`);
}
console.log(`\n[${cfg.step}] done in ${mins(Date.now() - started)} min`);
