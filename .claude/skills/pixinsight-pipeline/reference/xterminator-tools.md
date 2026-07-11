# Xterminator Tools (RC Astro) — PJSR Reference

All three are **native process modules** (.dylib), NOT scripts.

## StarXTerminator (SXT)

### Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `stars` | bool | false | Create separate star image (**the** key parameter) |
| `unscreen` | bool | false | Use unscreen method for star extraction |
| `overlap` | float | 0.20 | Tile overlap (0.05-0.75) |
| `ai_file` | string | *persisted!* | AI model file — **SET EXPLICITLY** (see below) |

> **Model trap (2026-07-10):** the module's persisted default on the Windows box was
> `StarXTerminator.lite.nonoise.11.pb` — every PJSR `new StarXTerminator` silently inherits
> it. Lite models are faster but separate stars from structure less cleanly. The pipeline
> pins `ai_file='StarXTerminator.11.pb'` (full model) at all five invocation sites. Available
> models live in `C:\Program Files\PixInsight\library\`. Check `(new StarXTerminator).toSource()`
> when in doubt — the same persisted-default risk applies to BXT/NXT model selection.

### Critical Rules
- **Linear data**: `P.stars = true` only (NO `P.unscreen`). Get starless + stars via subtraction.
- **Non-linear data**: `P.stars = true; P.unscreen = true`. Stars are screen-blend compatible.
- `P.starmask` does NOT exist. `P.linear` does NOT exist.
- Star image name: `<viewId>_stars` (detect by diffing image list before/after)

### Star Image Detection
```javascript
// Snapshot before
var before = [];
var wins = ImageWindow.windows;
for (var i = 0; i < wins.length; i++) before.push(wins[i].mainView.id);

P.executeOn(view);

// Find new images
var after = ImageWindow.windows;
for (var i = 0; i < after.length; i++) {
    if (before.indexOf(after[i].mainView.id) < 0) {
        // This is the star image
    }
}
```

### Double-SXT Nebulosity Recovery (Best Practice — pipeline DEFAULT)
SXT misclassifies compact knots/filament crossings as stars and pulls surrounding
nebulosity into the star image. Worst on SNR/emission filaments (IC 443 class targets).
The stolen structure is not lost — it is IN the star image. Recovery:
1. Run SXT again ON the star image. Its view becomes the leaked nebulosity
   (the "starless part" of the stars); the new window is the re-extracted clean stars.
2. Return the leak to the host: `$T + leak` (linear/subtractive extraction) or
   `~(~$T * ~leak)` (unscreened stars, screen algebra). Flux-conserving by construction.
3. Use the clean stars for the star branch; close the leak image.
Pipeline: `sxtRecoverNebulosity()` in run-pipeline.mjs, gated by `recoverNebulosity`
param (default **true**) on `sxt`/`ha_sxt`/`l_sxt`; in the non-linear star path the leak
is removed from the stars only (host was already recovered in the linear pass).
Prevention helps too: keep the SXT AI model current, use larger overlap, don't
over-smooth before SXT (blobby filaments look like stars).

### Non-Linear Star Extraction (Best Practice)
Avoids halo bloating from stretching linear stars:
1. Save pre-SXT checkpoint
2. Run SXT on linear main image (stars=true, no unscreen) — close linear stars
3. Stretch main image (HT + GHS)
4. Load pre-SXT checkpoint, apply identical stretch
5. Run SXT with `unscreen=true` on stretched pre-SXT image
6. Result: display-range stars compatible with screen blend

### SXT Unscreen Corrupts Saturated Cores on Bright Backgrounds (2026-07-11)
On a bright star superposed on a galaxy disk (M81, star at ~144 px from the core),
SXT unscreen extraction INVERTED the core color: a blue-white star (linear B/G ≈ 1.8)
came out with G ≈ 0.86, B ≈ 0.02, with checkered pixel-to-pixel chroma noise (this
was the "drizzle grid on green stars" complaint — the grid was never in the stacks).
Mechanism: SXT hallucinates part of the star's flux into the starless prediction
per-channel; the channel where the starless comes out nearly as bright as the
star-ful image gets `star ≈ 0` after unscreen. Fixing the masters cannot cure it.
**Fix (in pipeline Phase 8b):** clone the stretched pre-SXT image (`stretched_ref_core`)
before SXT; after extraction + hygiene, re-impose its hue on bright star-layer pixels
(smoothstep gate on star-layer max channel, `coreRepairStart` 0.45 / `coreRepairRamp`
0.20, ref smoothed σ=2), keeping the layer's own brightness profile. Near-identity
for honest stars. Config: `star_stretch.coreColorRepair` (default true).

### Screen Blend Recombination
```javascript
// PixelMath screen blend: ~(~starless * ~(strength * stars))
P.expression = '~(~$T * ~(' + strength + '*' + starsId + '))';
P.useSingleExpression = true;
P.executeOn(starlessView);
```

## NoiseXTerminator (NXT)

### Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `denoise` | float | 0.70 | Denoising strength (0-1) |
| `detail` | float | 0.15 | Detail preservation (0-1) |

### Recommended Strategy: Multiple Light Passes
Prefer multiple gentle applications over fewer heavy ones. Over-denoising causes:
plastic/waxy look, faint star loss, blurred edges, color smearing, reduced depth.

| Stage | Target | denoise | detail | Purpose |
|-------|--------|---------|--------|---------|
| Linear RGB | Before SXT | 0.25 | 0.15 | Clean noise before star separation |
| Post-stretch L | After L stretch | 0.25 | 0.15 | Clean stretched luminance |
| Post-stretch RGB | After main stretch | 0.25 | 0.15 | Clean stretched color |
| Final (optional) | After LHE/HDRMT | 0.15 | 0.15 | Light cleanup of amplified noise |

Each application should be a single run at low denoise — NOT high denoise values.

```javascript
var P = new NoiseXTerminator;
P.denoise = 0.25;
P.detail = 0.15;
P.executeOn(view);
```

## BlurXTerminator (BXT)

### Parameters — PJSR property names are **snake_case** (camelCase is silently ignored!)
| Parameter (PJSR) | Type | Default | Description |
|------------------|------|---------|-------------|
| `sharpen_stars` | float | 0.50 | Star sharpening amount |
| `adjust_halos` | float | 0 | Halo adjustment (negative = reduce) |
| `sharpen_nonstellar` | float | 0.50 | Extended feature sharpening |
| `correct_only` | bool | false | Only aberration correction, no sharpening |
| `correct_first` | bool | false | Correct before sharpen within one run |
| `nonstellar_then_stellar` | bool | false | Order of operations |
| `auto_nonstellar_psf` | bool | true | Auto-detect PSF from stars |
| `nonstellar_psf_diameter` | float | 0 | Manual PSF diameter (0-8 px; 0 = auto) |
| `lum_only` | bool | false | Process luminance only |
| `ai_file` | string | — | AI model file (e.g. `BlurXTerminator.4.pb`) |

> ⚠️ **CRITICAL:** BlurXTerminator PJSR properties are snake_case. Assigning the camelCase
> forms (`sharpenNonstellar`, `correctOnly`, …) does NOT error — it creates an ignored
> property and BXT runs at DEFAULTS. This silently no-op'd all BXT tuning in the pipeline
> until 2026-07-09. Verify with `typeof P.sharpen_nonstellar !== 'undefined'`. See
> pjsr-gotchas.md → "Process Parameter Names".

### Two-Pass Best Practice
1. **Pass 1 (correct_only)** — before color calibration:
   ```javascript
   P.correct_only = true;
   P.sharpen_stars = 0.50;
   P.sharpen_nonstellar = 0.75;   // ignored in correct_only mode
   ```
2. **Pass 2 (sharpening)** — after color calibration:
   ```javascript
   P.correct_only = false;
   P.sharpen_stars = 0.25;
   P.sharpen_nonstellar = 0.50;
   P.adjust_halos = -0.25;
   ```
