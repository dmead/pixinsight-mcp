# PJSR Gotchas & Constraints

## Language: ECMAScript 5 Only
PJSR runs ECMAScript 5. Do NOT use:
- `let`, `const` — use `var`
- Arrow functions `() => {}` — use `function() {}`
- Template literals `` `${x}` `` — use `'text' + x + 'text'`
- Destructuring, spread, `class`, `for...of`, `Promise`

## File I/O
```javascript
// Reading
var lines = File.readLines(path);       // returns array of strings
var text = lines.join('\n');

// Writing
File.writeTextFile(path, text);         // static method, no instance needed

// Checks
File.exists(path);
File.directoryExists(path);
File.createDirectory(path, true);       // recursive mkdir

// Listing
searchDirectory(dir + '/*.json');       // glob-like listing
```

**Do NOT use** `DataType_ByteArray` — it's not defined.

## XTerminator executeOn() returns false SILENTLY in fresh instances (LICENSE)
All three RC-Astro tools (NXT/BXT/SXT) return `executeOn() === false` — no exception,
no dialog — in freshly launched headless PixInsight instances while the SAME call works
in the watcher (verified 2026-07-12: watcher NXT true, fresh-instance NXT/BXT/SXT all
false). ROOT CAUSE (Dan): **the RC-Astro license key lives in per-instance-slot
settings** (same namespace as the swap-directory setting, see [[c-drive-full-swap-on-d]]
behavior). `-n` instances land on the next free slot; slots beyond the ones Dan has
licensed have no key, and automation mode suppresses the license dialog → silent false.
Which slot you get depends on how many instances are open — that's why headless XT
worked some days (low slot, licensed) and not others. Rules:
- Route ad-hoc XT work through the WATCHER via the bridge (idle only).
- ALWAYS verify effect (stddev before/after) when running XT outside the watcher.
- In new code, check `executeOn()`'s return value and log/fail on false.
- Durable fix: launch spare instances interactively and enter the license in a few
  more slots (Dan).

## Image.sample() ignores selectedChannel
`img.selectedChannel = c; img.sample(x, y)` does NOT read channel c — it silently reads
channel 0 every time, so per-channel probes come back identical across R/G/B (bit a
green-core scanner AND a phase-bisect probe on 2026-07-11 before being caught). Pass the
channel explicitly: `img.sample(x, y, c)`. `selectedRect` + statistics (`img.median()`)
DO honor selections; it's point sampling that doesn't.

### Windows path escaping when interpolating into PJSR strings
Node builds paths with backslashes (`path.join` → `C:\Users\dan\...`). Interpolating one
raw into a PJSR **string literal** eats the backslashes as JS escapes: `\U \d \p \c` collapse
and every separator vanishes → `C:Usersdan.pixinsight-mcppreviewscombine_rgb.jpg`, which then
fails with `Win32 error (5): Access is denied` (writing to a nonexistent parent). Two rules:
- Prefer the **JSON bridge** (`send('open_image', ..., { filePath })`) — JSON escapes safely.
- When you MUST interpolate a path into a `pjsr(\`...\`)` template, forward-slash it first:
  `filePath.replace(/\\/g, '/')`. PixInsight accepts forward slashes on Windows. Escaping only
  quotes (`.replace(/'/g, "\\'")`) is NOT enough — it leaves the backslashes to be eaten.
Bit both `savePreview` and `saveCheckpoint` (2026-07-09). A failed `saveAs` also raised a
**modal error dialog** that froze the resident watcher — recover by recycling the watcher
instance (kill + relaunch), not by waiting on a click. See [[pjsr-resident-script-locks-ui]].

### Exporting to PNG/JPEG — "insufficient numerical accuracy"
Saving a 32-bit image (int or float) straight to PNG (≤16-bit) or JPEG (8-bit) makes
PixInsight emit an **"insufficient numerical accuracy"** warning on every export (a modal
dialog in GUI instances). The written pixels are converted correctly, but convert explicitly
to silence it and make the depth intentional:
```javascript
tmp.setSampleFormat(16, false);   // on the export CLONE, never the working image
tmp.saveAs(pngPath, false, false, false, false);
```
Also policy (Dan, 2026-07-10): **pipeline previews are XISF ONLY.** JPEG loses information
(DCT artifacts masquerade as/hide grain, star profiles, chroma speckle) and even PNG raises
format warnings on the Windows box — XISF is native, warning-free, full fidelity, viewed in
PixInsight. `savePreview()` writes `<step>.xisf`. Raster exports (16-bit PNG with the
`setSampleFormat` conversion above) are allowed only as ephemeral crops in a throwaway
HEADLESS instance for automated visual checks — never through the watcher/GUI instance, and
never as deliverables. Measure quantitative things (noise autocorrelation, medians) on the
XISF itself, never an 8/16-bit export.

## ABE Enum Names (PixInsight ≥1.9.4)
`AutomaticBackgroundExtractor` prototype enums were renamed with prefixes; the old names
return `undefined`, and assigning that throws "invalid argument type: unsigned integer
value expected":

| Old (broken) | Current |
|---|---|
| `prototype.f32` (model format) | `prototype.ModelFormat_f32` |
| `prototype.SameAsTarget` | `prototype.CorrectedFormat_SameAsTarget` |
| `prototype.Subtract` | `prototype.Correction_Subtract` |

Probe pattern for any process enum rename: dump `Object.getOwnPropertyNames(Process.prototype)`
filtered to numeric values in a throwaway headless instance (`probe-abe-enums.js` approach).

**Related trap:** `toSource()` prints enums CLASS-level (`SpectrophotometricFluxCalibration.PSFType_Auto`)
but they live on the PROTOTYPE — class-level access returns `undefined` and assignment throws
"invalid argument type: unsigned integer value expected" (bit SPFC 2026-07-10). Always write
`Process.prototype.EnumName` regardless of what toSource shows.

**Same-name, different-units trap:** `BackgroundNeutralization.backgroundLow/High` are ABSOLUTE
pixel bounds in [0,1] (defaults 0.0/0.1), while `SpectrophotometricColorCalibration.backgroundLow/High`
are SIGMA values (defaults -2.8/+2.0). Copying SPCC's values into BN throws "numeric value out
of range: -2.8" (bit the SPFC+BN step 2026-07-10).

## Bridge command-file race (writer vs watcher poll)
The watcher polls `bridge/commands/*.json` and can read a HALF-WRITTEN file (Win32 error 32
sharing violation, or truncated JSON). It used to delete the file on parse failure — losing
the command and stalling the sender's poll for the full 60-min timeout. Fixed 2026-07-10 on
both ends; keep both invariants for any new bridge writer/reader:
- **Writers write atomically**: write `<id>.json.tmp`, then rename to `<id>.json`
  (`run-pipeline.mjs send()` does this; standalone .mjs helpers should too).
- **The watcher retries** a failed parse on later polls and only drops a command file after
  5 consecutive failures.

## LRGBCombination Interface (PixInsight ≥1.9.4)
The old per-channel properties (`channelL`, `channelR/G/B`, `lightness`, `saturation`) are
GONE. Assigning them creates inert JS properties — the process silently runs with its
DEFAULT channels table (all four enabled, empty ids), and empty ids auto-resolve to
`<targetId>_R` etc. → "Source image not found: <target>_R", executeOn returns false.

Current interface (from `(new LRGBCombination).toSource()`):
```javascript
P.channels = [        // [enabled, id, k] — row order R, G, B, L (L LAST; verified)
   [false, "", 1.0],
   [false, "", 1.0],
   [false, "", 1.0],
   [true, "L_work", 1.0]
];
P.mL = 0.5;           // was `lightness` (0.5 = neutral midtone)
P.mc = 0.5;           // was `saturation`
```
Diagnostic that found the row order: fill L=0.6, RGB=0.25; L-last → mean≈0.57 (real
lightness transfer); L-first → mean≈0.367 (=(0.6+0.25+0.25)/3, i.e. it replaced R).
General probe pattern for ANY silently-failing process: print `P.toSource()` of a default
instance — it shows the real parameter names and table shapes for the installed version.

## XISF Crop Masks
XISF files from WBPP contain embedded crop masks. Opening creates MULTIPLE windows:
```javascript
// After opening XISF, close crop masks:
var wins = ImageWindow.windows;
for (var i = 0; i < wins.length; i++) {
    if (wins[i].mainView.id.indexOf('crop_mask') >= 0) {
        wins[i].forceClose();
    }
}
```

## PixelMath in Global Context
`createNewImage = true` with `executeGlobal()` requires ALL of:
- `newImageWidth`, `newImageHeight`
- `newImageColorSpace` (`PixelMath.prototype.RGB` or `.Gray`)
- `newImageSampleFormat` (`PixelMath.prototype.f32`)

Without these: "Cannot execute instance in the global context" error.

## PixelMath Limitations
- **CIEL()/color-space functions in a single expression on an RGB target COLLAPSE the
  image to luminance** (all three channels come out identical — bit the IFN blend
  2026-07-10). Build masks needing CIEL as a separate GRAYSCALE image first, then keep
  the RGB expression purely scalar ($T, image refs, mask refs).
- **No `pow()` function** — use `exp(exponent * ln(base))` instead
- **`^` operator** works for fractional/negative exponents
- Negative numbers must be wrapped: `(-1.859)` not `-1.859` in some contexts
- `P.use64BitWorkingImage = true; P.truncate = true` for precision

## StarAlignment
- Output directory path must have **NO SPACES** — PJSR silently fails
- Use `/tmp/aligned/` or `~/.pixinsight-mcp/aligned/` instead
- `targets` format: `[[enabled, drizzle, filepath]]`

## eval() Context
- `#include` directives don't work inside eval — they're compile-time
- Code goes through JSON.stringify → JSON.parse → eval (beware escaping)
- Single quotes in PJSR code work fine
- Write long scripts to `/tmp/` files to avoid escaping issues

## Process Parameter Names — snake_case vs camelCase (SILENT no-op trap)
- PJSR process property names must match the module EXACTLY. Assigning an unknown
  property (e.g. wrong case) does NOT error — it creates an ignored JS property and the
  process runs at its **defaults**. This fails silently: the config value looks applied
  but nothing changes.
- **BlurXTerminator uses snake_case**: `sharpen_stars`, `sharpen_nonstellar`,
  `adjust_halos`, `correct_only`, `correct_first`, `nonstellar_then_stellar`, `lum_only`,
  `nonstellar_psf_diameter`, `auto_nonstellar_psf`, `ai_file`. The camelCase forms
  (`sharpenStars`, `sharpenNonstellar`, `adjustStarHalos`, `correctOnly`) are **undefined**
  and silently ignored → BXT ran at default 0.5/0.5 with `correct_only=false` for EVERY
  iteration until fixed (2026-07-09). Symptom: changing a BXT value produced a
  pixel-identical output (mean|diff| = 0.000000).
- **Always verify a param took effect** when a value change should visibly matter: probe
  `typeof P.someProp` (===\"undefined\" means wrong name), or diff two outputs. `for(k in new
  BlurXTerminator)` dumps the real property names.
- Suspect this whenever "raising X did nothing" — check the property name before assuming
  the data is resolution-limited.

## Process Module Availability
- Not all PI processes are installed as `.dylib` modules
- Check: `/Applications/PixInsight/bin/<ProcessName>-pxm.dylib`
- GHS is script-only (no .dylib) — must use PixelMath fallback
- SXT/NXT/BXT ARE native modules
- Runtime check: `try { new ProcessName; } catch(e) { /* not available */ }`

## UI Responsiveness
- `processEvents()` is CRITICAL in any loop to prevent freeze
- `msleep(ms)` blocks completely — no UI events during sleep
- Pattern: alternate `msleep(50)` with `processEvents()` in idle loops
- During `P.executeOn(view)`, UI is blocked — unavoidable

## Memory Management
- PixInsight accumulates undo history — each operation adds ~300MB per 6000x4000 RGB image
- **Purge undo history** with `w.purge()` after mask-heavy steps (LHE, HDRMT) and merge points
- **Close images when done**: L_work after LRGB combine, stars after star addition, masks after use
- Check OS-level memory between heavy steps (BXT, NXT, SXT, SPCC)
- Close crop masks, ABE models, alignment outputs immediately
- Each 5972x3920 f32 RGB image ≈ 280MB RAM (plus undo = 280MB per operation)
- Thresholds: warn=4GB (auto-purge), abort=8GB (auto-checkpoint + exit)
- Without purging: 44GB observed. With purging: peak 1.3GB for same pipeline.
- After pipeline crash: relaunch PixInsight, resume from checkpoint with `--restart-from`

## ImageWindow Constructor — Dimension Bug
PJSR `Image.width` / `Image.height` properties don't pass cleanly as arguments to
`new ImageWindow(width, height, ...)`. The constructor throws "invalid dimension(s)"
even though the values appear correct.

**Workaround: Two-call pattern**
1. First PJSR call: query dimensions as JSON
```javascript
var img = srcW.mainView.image;
JSON.stringify({ w: Math.round(img.width), h: Math.round(img.height) });
```
2. Second PJSR call: use JS template literals to inject literal numbers
```javascript
var mw = new ImageWindow(${dims.w}, ${dims.h}, 1, 32, true, false, 'maskId');
```

The key is that `${dims.w}` gets interpolated by JavaScript (Node.js) into a literal
number like `5972` BEFORE the PJSR code is sent to PixInsight. This avoids passing
PJSR Image property values directly to the constructor.

Also use `floatSample=true` (5th arg) for mask windows — `false` creates integer images
which behave differently for PixelMath operations.

## ImageWindow.windowById() Never Returns Null
`ImageWindow.windowById('someId')` **always** returns an ImageWindow object, even if no
window with that ID exists. The returned object has `.isNull === true` when not found.

**WRONG:**
```javascript
var w = ImageWindow.windowById('myView');
if (!w) throw new Error('not found');  // NEVER throws — w is always truthy!
if (w ? 'yes' : 'no')  // ALWAYS 'yes'!
```

**CORRECT:**
```javascript
var w = ImageWindow.windowById('myView');
if (w.isNull) throw new Error('not found');  // Properly checks
w.isNull ? 'no' : 'yes';  // Correct boolean check
```

This is a critical PJSR gotcha — caused mask creation to silently fail for 4 iterations
because the Ha_work existence check always returned 'yes'.

## Astrometry Transfer
```javascript
// Copy WCS solution from source to destination
dstWindow.copyAstrometricSolution(srcWindow);
```
Essential after creating PixelMath composites — SPCC needs WCS data.

## SubframeSelector Headless Measurement (measure-subs.js)
`pjsr/measure-subs.js` + `scripts/select-subs.mjs` measure calibrated subs headlessly
(FWHM, eccentricity, median, star count, PSFSignalWeight + a corner-box gradient
metric) and statistically cull outliers before stacking. Validated on Sh2-101
2026-07-18 (363 subs → 244 kept).

**Measurement column layout is NOT what older docs say.** On PI 1.9.x the
`P.measurements` row is: `index(0), enabled(1), locked(2), filePath(3), weight(4),
FWHM(5), eccentricity(6), PSFSignalWeight(7), unused01(8), SNRWeight(9), median(10),
medianMeanDev(11), noise(12), noiseRatio(13), stars(14), ... azimuth(19),
altitude(20)`. Note `unused01` at index 8 shifting everything after it, and
PSFSignalWeight at 7 (not appended at the end). Never trust remembered layouts —
probe with `log(P.toSource())` + `JSON.stringify(P.measurements[0])` on 3 files
first. `P.measurements` median is pedestal-corrected; a raw `image.median()` on the
opened file is not.

## Mixed Calibration Pedestals Poison Naive Background Metrics
A calibrated-lights folder can silently mix pedestal conventions (some subs ~+0.0155
pedestal, some none — even within the same night). Any metric using an absolute image
median then splits into two bogus populations (observed: identical sky, "gradient"
0.38 vs 0.046, purely from the denominator). Fixes: difference-based numerators
(corner max−min cancels a constant pedestal) and the SubframeSelector
pedestal-corrected median as denominator. Also: a center box on the target measures
nebulosity, not gradient — use corner boxes only for gradient spread.
