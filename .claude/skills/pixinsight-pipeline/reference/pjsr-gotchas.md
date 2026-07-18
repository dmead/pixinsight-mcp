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
