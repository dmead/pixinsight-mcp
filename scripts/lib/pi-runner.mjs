// pi-runner.mjs — shared helpers for driving headless PixInsight instances.
//
// Extracted from the launch/lock/poll code in stack-m82.mjs so a second
// orchestrator does not have to copy it. stack-m82.mjs still carries its own
// copy; it is validated and running, and rewiring it was not worth the risk of
// breaking a working stack mid-project.
//
// Run with the winget Node v24 binary — the `node` on PATH is v10 and dies on
// the first import having run zero lines.

import { spawn } from 'child_process';
import fs from 'fs';

export const PIX = 'C:/Program Files/PixInsight/bin/PixInsight.exe';
export const WBPP_JS = 'C:/Program Files/PixInsight/src/scripts/BatchPreprocessing/WBPP.js';

// Every instance must be pointed at a swap location explicitly. PixInsight
// settings are per instance SLOT, so a `-n` instance gets the factory C: temp
// default, and `ImageWindow.swapDirectories = [...]` in PJSR is an INERT
// assignment — the TMP/TEMP environment override at launch is the only thing
// that actually moves the swap.
//
// D: is the historical location but is down to ~9 GB free (2026-08-11), and
// running out mid-integration raises a modal that suspends a headless instance
// indefinitely. Override with PI_SWAP for heavy runs; Z: is also a local NTFS
// disk (only Y: is the NAS) and has far more room.
export const SWAP = process.env.PI_SWAP || 'D:\\Temp\\pixinsight-swap';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const mins = (ms) => Math.round(ms / 60000);
export const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

export function listFiles(d, pred) {
  try { return fs.readdirSync(d).filter(pred); } catch { return []; }
}

/** Recursively collect files under `dir` matching `pred` (basename). */
export function walkFiles(dir, pred, out = [], depth = 0) {
  if (depth > 6) return out;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walkFiles(p, pred, out, depth + 1);
    else if (pred(e.name)) out.push(p);
  }
  return out;
}

// ---- launch mutex ---------------------------------------------------------
// Instances starting in the same window race for the instance slot and hang.
// Same pattern as pix-planetary/scripts/pi-lock.mjs.
const LOCK = 'D:/Temp/pi-launch.lock';

export async function withPiLaunchLock(fn) {
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
      } catch { /* lock vanished between statting and reading */ }
      await sleep(400 + Math.random() * 400);
    }
  }
  try {
    const result = await fn();
    await sleep(6000);
    return result;
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

export function launch(args) {
  for (const a of args)
    if (a.includes('"')) throw new Error(`Bad arg (quote): ${a}`);
  return spawn(PIX, args, {
    env: { ...process.env, TMP: SWAP, TEMP: SWAP },
    stdio: 'ignore',
    detached: false,
  });
}

export function kill(pid) {
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

/**
 * Build the argv for `-r=script,arg,arg`.
 *
 * PixInsight splits that value on COMMAS, so no argument may contain one.
 * Spaces are safe: the whole `-r=...` is a single argv element and spawn() is
 * given no shell. That matters here because the Sh2-101 library lives under
 * `Z:/Sh2 101`.
 */
export function runScriptArgs(scriptPath, scriptArgs) {
  const parts = [scriptPath, ...scriptArgs.map(String)];
  for (const p of parts)
    if (p.includes(',')) throw new Error(`Argument contains a comma (breaks -r=): ${p}`);
  return ['-n', '--automation-mode', '--no-splash', `-r=${parts.join(',')}`, '--force-exit'];
}

/** Build the argv for a WBPP automation run from `key=value` params. */
export function wbppArgs(params) {
  for (const p of params) {
    if (p.includes(',')) throw new Error(`WBPP param contains a comma (breaks -r=): ${p}`);
    if (p.split('=').length !== 2) throw new Error(`Malformed WBPP param: ${p}`);
  }
  return ['-n', '--automation-mode', '--no-splash',
    `-r=${[WBPP_JS, ...params].join(',')}`, '--force-exit'];
}

/**
 * Run one PixInsight instance and poll until `isDone()` or the process exits.
 *
 * Completion is judged by OUTPUT FILES, never by log activity or process
 * liveness: a PJSR script rewriting its log over SMB can look frozen while it
 * is in fact completing, and WBPP can exit non-zero after writing everything.
 *
 * `verify`, if given, is called each poll with the elapsed ms and may return a
 * string to abort the run early (used to catch a pipeline builder that never
 * reported OK, which otherwise wastes hours producing the wrong output).
 */
export async function runInstance({ label, args, isDone, progress, verify,
                                    pollMs = 60_000, absoluteMs = 20 * 3600_000 }) {
  if (isDone()) {
    console.log(`[${label}] already complete — skipping`);
    return true;
  }
  console.log(`[${label}] launching PixInsight`);
  const started = Date.now();
  const child = await withPiLaunchLock(async () => launch(args));

  let exited = false;
  child.on('exit', (code) => { exited = true; console.log(`[${label}] instance exited (code ${code})`); });

  for (;;) {
    await sleep(pollMs);
    const elapsed = Date.now() - started;

    if (verify) {
      const abort = verify(elapsed);
      if (abort) {
        console.error(`[${label}] ${abort} — killing the run`);
        kill(child.pid);
        await sleep(10_000);
        return false;
      }
    }

    if (isDone()) {
      // Let the instance close its files before the next step reads them.
      for (let w = 0; w < 24 && !exited; ++w) await sleep(5000);
      break;
    }
    if (exited) break;

    if (elapsed > absoluteMs) {
      console.error(`[${label}] absolute timeout — killing`);
      kill(child.pid);
      await sleep(10_000);
      break;
    }
    console.log(`[${label}] ${mins(elapsed)} min${progress ? ` — ${progress()}` : ''}`);
  }

  const ok = isDone();
  console.log(`[${label}] ${ok ? 'complete' : 'INCOMPLETE'} after ${mins(Date.now() - started)} min`);
  return ok;
}
