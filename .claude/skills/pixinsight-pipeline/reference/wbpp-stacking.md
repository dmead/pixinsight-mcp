# WBPP Headless Stacking & Drizzle Optimization

Validated 2026-07-08 on IC 443 (792 calibrated subs, LRGB + SHO, QHY533M @ TS-70 440mm,
1.76"/px, 58 nights). WBPP 3.0.1, PixInsight 1.9.4 Lockhart, Windows.

## Headless WBPP invocation (automation mode)

WBPP ≥3.0 supports full command-line automation — no GUI, scriptable from Node/PowerShell:

```powershell
& "C:\Program Files\PixInsight\bin\PixInsight.exe" -n --automation-mode `
  -r="C:/Program Files/PixInsight/src/scripts/BatchPreprocessing/WBPP.js,automationMode=true,param=value,..." --force-exit
```

- Parameters are comma-separated inside the `-r=` string; paths may contain spaces but never commas.
- Full parameter list: `BPP-automation.js` → `printAutomationHelp()`, or Alt+A in the WBPP GUI.
- Automation mode **inherits persisted GUI settings**; CLI params override only what you pass.
  Always pin every setting you care about (see traps below).
- **File lists are CLI-only**: automation mode adds files exclusively from `dir=`/`file=`
  params (`parseFileParameters` in `BPP-automation.js`) — persisted GUI *file lists* (e.g. a
  stale master bias) do NOT carry over. Verified in source and by group audit 2026-07-10.
  Unknown param names are silently ignored (`Parameters.set` of a key nothing reads).
- Parameter order in `BPP-main.js`: CLI params → `importParameters` → files added → pipeline built.
- **Bias/calibration audit pattern**: the pipeline-builder script can enumerate
  `engine.groupsManager.groupsForMode(BPP.GroupingMode.PRE/POST)` and log each group's
  `imageType`/`filter`/`fileItems.length`, writing an inventory + ALERT file if any
  non-Light group exists. Gives positive in-run proof no calibration masters entered
  (see `wbpp-clean-builder.js` pattern, IC 443 clean rerun 2026-07-10).

### Settings used for IC 443 (already-calibrated lights, multi-night, mixed exposures)

**Canonical IC 443 input is `Z:/IC 443/all-cropped-no-overscan/` (792 subs, 3008×3011,
overscan strip pre-cropped) — NOT `all-calibrated-lights/` (804 subs, 3008×3028, overscan
still present, includes 12 extra 600s Ha the cropped set excludes).** The validated
2026-07-08 masters and the 2026-07-10 clean rerun both stack the cropped set. Expected
active counts after minWeight drops: 763 of 792 (26 Ha + 3 OIII cut).

```
automationMode=true, dir=<lights>, outputDirectory=<out>,
autoIntegrationMode=false,            # CRITICAL — see trap #1
lightExposureTolerancePost=600,       # merge 180/300/600s subs into one group per filter
subframeWeightingEnabled=true,        # PSF Signal Weight (default preset)
imageRegistration=true, pixelInterpolation=10,
bestFrameReferenceMethod=1,           # one global auto reference → all masters co-registered
localNormalization=true, localNormalizationInteractiveMode=false,
frameSelectionInteractive=false,      # REQUIRED headless or a dialog blocks forever
rejection_4=5,                        # Auto → ESD for large groups
lightsLargeScaleRejectionHigh=true,   # satellite trails
generateRejectionMaps=false, autocrop=true, platesolve=true, integrate=true
```

Low-weight subs are dropped automatically by `minWeight` (default 0.05 normalized PSF
Signal Weight) — on IC 443 this cut 26/141 Ha + 3/156 OIII cloudy subs. Intentional; check
the "(N active)" counts in the log.

### Dan's canonical Image Integration settings (GUI reference, 2026-07-11)
Match these in every automation stack (his GUI screenshot is authoritative):
```
combination Average (default), minWeight=0.05,
rejection_4=3 (Generalized ESD — EXPLICIT; "Auto" picks linear-fit on big groups and
  linear-fit leaks dither-gap hot pixels), ESD_Outliers_4=0.10 (NOT the 0.30 PI default),
ESD_Significance_4=0.05,
lightsLargeScaleRejectionHigh=true (layers 2, growth 2),
lightsLargeScaleRejectionLow=true  (layers 2, growth 2)   <- BOTH high AND low
```
Also standard for this workflow: CosmeticCorrection (auto 3σ) on the calibrated subs
BEFORE stacking — per-pixel rejection cannot catch hot pixels that repeat at the same sky
position through dither gaps.

## Traps

1. **Auto FastIntegration ≥150 frames.** `autoIntegrationMode` defaults to true: any
   post-calibration light group with ≥150 frames silently switches to FastIntegration,
   which bypasses PSF weighting and Local Normalization. Pass `autoIntegrationMode=false`.
   (`BPP-FrameGroup.js` — `BPP.Defaults.autoFastIntegrationThreshold = 150`.)
2. **Killed runs leave `_r.*` collisions.** If a run is killed after registration, a rerun
   writes `_r_1.*` beside the stale `_r.*`. Anything that globs `*.xdrz` (e.g. the drizzle
   optimizer) then ingests both. Quarantine the stale set first; only xdrz containing
   `LocationEstimates`/`Weights` (~100 KB) are closed by ImageIntegration — registration-only
   xdrz are ~1 KB.
3. **Log flushes per operation.** `outputDirectory/logs/<ts>.log` only receives content when
   an operation completes (`ConsoleLogger.flush`). The 792-frame measurement phase is ONE
   operation → the log looks frozen for its whole duration while CPU is pegged. Not a hang.
4. **No CLI parameter for drizzle.** Drizzle is per-group state. Use a pipeline builder
   script (below).
5. **WBPP empties its file cache at run start** ("Empty file cache") — a rerun re-measures
   everything; don't count on cross-run caching.

## Enabling drizzle headless: pipeline builder script

`usePipelineBuilderScript=true, pipelineBuilderScriptFile=<path>` (both are CLI params).
The script is eval'd inside `PipelineManager.runPipelineBuilder()` with `engine` and `this`
(the PipelineManager) in scope. If it succeeds it REPLACES the default light pipeline, so
mutate groups and then call `this.buildPipelineForLight()` yourself:

```js
let groupsPOST = engine.groupsManager.groupsForMode( BPP.GroupingMode.POST );
for ( let i = 0; i < groupsPOST.length; ++i )
{
   let g = groupsPOST[ i ];
   if ( g.imageType == ImageType.Light && g.isDrizzleAvailable() )
   {
      g.enableDrizzle();
      g.setDrizzleScale( 2 );
      g.setDrizzleDropShrink( 0.9 );      // safe baseline; optimize afterwards
      g.setDrizzleFast( false );          // regular drizzle
      g.setDrizzleFunction( DrizzleIntegration.Kernel_Square );
      g.setDrizzleGridSize( 16 );
   }
}
this.buildPipelineForLight();
```

Defaults if unset: `drizzleScale: 1` (!), `drizzleFast: true`, dropShrink 0.9 mono / 1.0 CFA.

## Drop shrink optimization (dmead/drizzleoptimizer)

`https://github.com/dmead/drizzleoptimizer` — PJSR script; binary-searches the minimum
clean drop shrink per filter using p05 lag-1 tile correlation (<0.50 ⇒ grid artifacts).

- Needs **closed** xdrz (run the WBPP drizzle pass first — see trap #2).
- Point `PARAMS.registeredDir` at WBPP's `registered/`; it auto-discovers filter subdirs.
- Headless: PJSR console output is not captured — patch `log()` to mirror lines to a file.
- Each test is a full DrizzleIntegration; a 7-filter run is ~50+ integrations. PixInsight
  crashed after ~36 consecutive integrations in one instance — run **one instance per
  filter**, sequentially, and log per filter so a crash never loses finished results.

IC 443 results (2x, square kernel, p05 threshold 0.50): lum 0.200, red 0.200, sulfur 0.200
(all clean across the full range), green 0.488, halpha 0.587, blue 0.619, oxygen3 0.694.
Recommended drop shrink is set by dither coverage, not simply frame count (OIII had the
most frames but the highest drop shrink).

Headless monitoring lessons (hard-won):
- Some PixInsight automation instances genuinely exit early on transient errors — wrap
  `executeGlobal()` in try/catch that logs, make scripts idempotent (skip existing
  outputs), and drive with a retry loop. Identical inputs succeeded on rerun.
- Do NOT verify progress by tailing a log the PJSR script rewrites per-line over an SMB
  share: the concurrent reader can lock the file, the (guarded) write starts failing, the
  log freezes, and the run looks dead while it is actually completing. Judge completion by
  OUTPUT FILES existing, never by log activity or process-liveness checks alone.
- Close every window a batch DrizzleIntegration creates (integration AND `drizzle_weights`,
  or set `showImages=false`) — leaked windows accumulate across dozens of integrations.

## Final masters

Re-run DrizzleIntegration per filter at the recommended drop shrink over the closed xdrz
(enable image weighting + rejection; enable local normalization to match WBPP's own
drizzle invocation) and save as XISF. The WBPP `master/` output at drop shrink 0.9 serves
as the baseline/fallback.

**Custom DrizzleIntegration output has NO astrometric solution (WCS).** So any working
master derived from it (crop, LinearFit, PixelMath) is also WCS-less, and **SPCC silently
fails** on it ("SPCC returned false — check WCS/metadata"; pre/post medians identical → an
UNCALIBRATED, magenta-background result, not a display artifact). Fix: plate-solve the
broadband R master (watcher's embedded ImageSolver, seed ra/dec/resolution) AFTER every
prep/crop that regenerates it — a re-crop wipes the WCS. Bake the solve into any
prep→stars→composite chain, before the SPCC-bearing run. Diagnose SPCC-failed vs
working by comparing pre- vs post-SPCC channel medians in the log.

**Local Normalization is NOT a corner-gradient source** (IC 443 test: WITH LN 3.3% corner
spread vs WITHOUT 4.3% — LN helps). To trace a master's corner falloff, measure
corner/center in individual CALIBRATED subs: flat subs (~1.000) + falloff only in the
master ⇒ it's drizzle edge-coverage (corners get fewer contributing frames at 2x+dither)
and averaged residual sky gradients, NOT bad flats. Fix with an edge crop (trim the
falloff zone) + a gentle post-stretch background pass, not a data redo. A ~1% linear
residual stretches to ~13% visible — background extraction can only mitigate, not zero it.

DBE (DynamicBackgroundExtraction) is a DYNAMIC/interactive process — `executeOn` CRASHES
the headless instance. Not scriptable for automation. Use ABE (AutomaticBackgroundExtractor)
instead: scriptable, does grid-sampling with sigma outlier rejection like DBE. Post-stretch
ABE (deg 2) via the `gc_post` step is the residual-corner flattener.
