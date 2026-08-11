// final-drizzle.js — final per-filter DrizzleIntegration at the optimized drop
// shrink, plus a coverage-cropped variant carrying a valid WCS.
//
// jsArguments: [filterDir, dropShrink, outFullPath, outCropPath, wcsRefPath, logPath, drizzleScale]
//   filterDir    — WBPP registered/<filter> directory containing .xdrz
//   dropShrink   — the value recommended by drizzle-optimize.js
//   outFullPath  — full-frame master (XISF)
//   outCropPath  — coverage-cropped master (XISF)
//   wcsRefPath   — WBPP's own master/..._drizzle_2x.xisf for this filter. Custom
//                  DrizzleIntegration output has NO astrometric solution, and
//                  SPCC then fails SILENTLY on anything derived from it. Same
//                  xdrz set + same scale ⇒ identical geometry, so the solution
//                  transplants exactly. (ImageSolver is a known failure on this
//                  drizzled data — do not substitute it.)
//   logPath      — log file; heartbeat at logPath + ".status"
//   drizzleScale — integer, e.g. 2
//
// Drop shrink does not change output geometry, only how much each input pixel
// is shrunk before it is dropped onto the output grid — which is why the WBPP
// master at 0.9 is a valid WCS donor for a master at any other value.
// ES5 only.

var MIN_XDRZ_BYTES = 20 * 1024;

// Coverage crop: keep pixels whose drizzle weight is at least this fraction of
// the central reference level, and never trim more than MAX_TRIM_FRAC per side.
var COVERAGE_FRAC = 0.5;
var MAX_TRIM_FRAC = 0.15;
var FALLBACK_TRIM_FRAC = 0.12;

var filterDir    = jsArguments[0];
var dropShrink   = parseFloat(jsArguments[1]);
var outFullPath  = jsArguments[2];
var outCropPath  = jsArguments[3];
var wcsRefPath   = jsArguments[4];
var logPath      = jsArguments[5];
var drizzleScale = parseInt(jsArguments[6], 10);

var statusPath = logPath + ".status";
var LOG = [];

function log(msg) {
   console.writeln("[final] " + msg);
   LOG.push(msg);
   try {
      File.writeTextFile(logPath, LOG.join("\n") + "\n");
   } catch (e) {
   }
}

function heartbeat(msg) {
   try {
      File.writeTextFile(statusPath, msg);
   } catch (e) {
   }
}

function closeById(id) {
   if (!id) return;
   try {
      var w = ImageWindow.windowById(id);
      if (w && !w.isNull) w.forceClose();
   } catch (e) {
   }
}

function collectXdrzFiles(dir) {
   var files = [];
   var skipped = 0;
   var d = new FileFind();
   if (d.begin(dir + "/*.xdrz")) {
      do {
         if (d.name != "." && d.name != "..") {
            if (d.size >= MIN_XDRZ_BYTES)
               files.push(dir + "/" + d.name);
            else
               skipped++;
         }
      } while (d.next());
      d.end();
   }
   if (skipped > 0)
      log("Skipped " + skipped + " unclosed .xdrz (< " + MIN_XDRZ_BYTES + " bytes).");
   if (files.length === 0)
      throw new Error("No usable .xdrz files found in: " + dir);
   return files;
}

// ---------------------------------------------------------------------------
// Coverage crop rectangle, from the drizzle weights image.
//
// Shrink each edge inward until every pixel on that border line carries at
// least COVERAGE_FRAC of the central weight level. Greedy and conservative:
// the result contains no under-covered pixel, which is what the edge falloff
// (corners get fewer contributing frames at 2x + dither) demands.
// ---------------------------------------------------------------------------
function coverageRect(img) {
   var W = img.width, H = img.height;

   img.selectedRect = new Rect(Math.floor(W * 0.25), Math.floor(H * 0.25),
                               Math.floor(W * 0.75), Math.floor(H * 0.75));
   var ref = img.median();
   img.resetSelections();
   log("  central weight median: " + ref.toFixed(6));

   if (!(ref > 0)) {
      log("  WARNING: central weight median is zero — falling back to fixed inset");
      return null;
   }
   var thr = ref * COVERAGE_FRAC;

   var x0 = 0, y0 = 0, x1 = W, y1 = H;   // [x0,x1) [y0,y1)
   var maxTrimX = Math.floor(W * MAX_TRIM_FRAC);
   var maxTrimY = Math.floor(H * MAX_TRIM_FRAC);

   function lineMin(rx0, ry0, rx1, ry1) {
      img.selectedRect = new Rect(rx0, ry0, rx1, ry1);
      var m = img.minimum();
      img.resetSelections();
      return m;
   }

   var guard = 0;
   for (;;) {
      if (++guard > 4 * (maxTrimX + maxTrimY) + 16) {
         log("  WARNING: coverage scan did not converge");
         return null;
      }
      var moved = false;

      if (y0 < maxTrimY && lineMin(x0, y0, x1, y0 + 1) < thr)      { y0++; moved = true; }
      if (H - y1 < maxTrimY && lineMin(x0, y1 - 1, x1, y1) < thr)  { y1--; moved = true; }
      if (x0 < maxTrimX && lineMin(x0, y0, x0 + 1, y1) < thr)      { x0++; moved = true; }
      if (W - x1 < maxTrimX && lineMin(x1 - 1, y0, x1, y1) < thr)  { x1--; moved = true; }

      if (!moved)
         break;
   }

   // Did we stop because the frame is clean, or because we hit the trim cap?
   var capped = (y0 >= maxTrimY) || (H - y1 >= maxTrimY) ||
                (x0 >= maxTrimX) || (W - x1 >= maxTrimX);
   if (capped) {
      log("  WARNING: coverage trim hit the " + (MAX_TRIM_FRAC * 100) +
          "% cap — falling back to fixed inset");
      return null;
   }

   return { x0: x0, y0: y0, x1: x1, y1: y1 };
}

function fixedInsetRect(W, H) {
   var tx = Math.floor(W * FALLBACK_TRIM_FRAC);
   var ty = Math.floor(H * FALLBACK_TRIM_FRAC);
   return { x0: tx, y0: ty, x1: W - tx, y1: H - ty };
}

function saveWindow(win, path) {
   if (!win.saveAs(path, false /*queryOptions*/, false /*allowMessages*/,
                   false /*strict*/, false /*verifyOverwrite*/))
      throw new Error("saveAs failed: " + path);
   log("  Saved: " + path);
}

// ---------------------------------------------------------------------------
function main() {
   heartbeat("starting");
   log("=== final-drizzle ===");
   log("filterDir:  " + filterDir);
   log("dropShrink: " + dropShrink);
   log("scale:      " + drizzleScale + "x");
   log("wcsRef:     " + wcsRefPath);

   var xdrzFiles = collectXdrzFiles(filterDir);
   log("frames: " + xdrzFiles.length);

   // Local normalization data must be passed EXPLICITLY as the third element of
   // each inputData row — the .xdrz does NOT reference the .xnml, so
   // enableLocalNormalization alone applies nothing. WBPP does the same
   // (BPP-processing.js:1624) and, like it, requires EVERY frame to have LN
   // data before using any: mixing normalized and un-normalized frames in one
   // integration is worse than using none.
   var lnFiles = [];
   var missingLn = 0;
   for (var li = 0; li < xdrzFiles.length; ++li) {
      var xnml = xdrzFiles[li].replace(/\.xdrz$/i, ".xnml");
      if (File.exists(xnml))
         lnFiles.push(xnml);
      else {
         lnFiles.push("");
         missingLn++;
      }
   }
   var useLN = (missingLn === 0);
   log("local normalization: " + (useLN ? "ON (" + lnFiles.length + " .xnml)" :
       "OFF — " + missingLn + " of " + xdrzFiles.length + " frames lack .xnml"));
   if (!useLN)
      log("  WARNING: integrating WITHOUT local normalization");

   var D = new DrizzleIntegration();
   D.inputData = xdrzFiles.map(function(f, i) {
      return [true, f, useLN ? lnFiles[i] : ""];
   });
   D.scale                = drizzleScale;
   D.dropShrink           = dropShrink;
   D.kernelFunction       = DrizzleIntegration.prototype.Kernel_Square;
   D.enableRejection      = true;
   D.enableImageWeighting = true;
   D.enableSurfaceSplines = false;
   D.enableLocalNormalization = true;
   D.closePreviousImages  = false;
   D.showImages           = false;
   D.noGUIMessages        = true;

   log("--- DrizzleIntegration parameters ---");
   log(D.toSource());

   heartbeat("integrating");
   if (!D.executeGlobal())
      throw new Error("DrizzleIntegration returned false");

   var win = ImageWindow.windowById(D.integrationImageId);
   if (!win || win.isNull)
      throw new Error("integration window not found: " + D.integrationImageId);
   var weightsId = D.weightImageId;

   var W = win.mainView.image.width, H = win.mainView.image.height;
   log("integration: " + W + "x" + H + "  id=" + D.integrationImageId);

   // ---- WCS transplant onto the full-frame master ----
   heartbeat("wcs");
   var ref = null;
   try {
      var refs = ImageWindow.open(wcsRefPath);
      if (refs && refs.length > 0)
         ref = refs[0];
      // XISF files open extra windows (crop_mask, rejection maps) — close them.
      for (var i = 1; i < refs.length; ++i)
         refs[i].forceClose();
   } catch (e) {
      log("  WARNING: could not open WCS reference: " + e.message);
   }

   if (ref && !ref.isNull) {
      var rw = ref.mainView.image.width, rh = ref.mainView.image.height;
      if (rw != W || rh != H)
         log("  WARNING: WCS reference is " + rw + "x" + rh + " but master is " +
             W + "x" + H + " — NOT copying astrometry");
      else if (!ref.hasAstrometricSolution)
         log("  WARNING: WCS reference has no astrometric solution");
      else {
         win.copyAstrometricSolution(ref);
         log("  astrometry copied; hasAstrometricSolution=" + win.hasAstrometricSolution);
      }

      // Carry the observation keywords too — SPCC and any later solve want them.
      var rKW = ref.keywords, tKW = win.keywords;
      var names = ["DATE-OBS", "DATE-END", "EXPTIME", "TELESCOP", "INSTRUME", "OBJECT",
                   "FILTER", "FOCALLEN", "XPIXSZ", "YPIXSZ", "RA", "DEC",
                   "OBJCTRA", "OBJCTDEC", "OBSGEO-L", "OBSGEO-B", "OBSGEO-H",
                   "LONG-OBS", "LAT-OBS", "ALT-OBS"];
      var copied = [];
      for (var k = 0; k < names.length; ++k) {
         var exists = false;
         for (var j = 0; j < tKW.length; ++j)
            if (tKW[j].name == names[k]) { exists = true; break; }
         if (exists) continue;
         for (var m = 0; m < rKW.length; ++m)
            if (rKW[m].name == names[k]) {
               tKW.push(new FITSKeyword(rKW[m].name, rKW[m].value, rKW[m].comment));
               copied.push(names[k]);
               break;
            }
      }
      win.keywords = tKW;
      log("  keywords copied: " + (copied.length ? copied.join(",") : "<none needed>"));

      ref.forceClose();
   }

   heartbeat("saving full");
   saveWindow(win, outFullPath);

   // ---- coverage crop ----
   heartbeat("cropping");
   var rect = null;
   var wWin = weightsId ? ImageWindow.windowById(weightsId) : null;
   if (wWin && !wWin.isNull) {
      log("computing coverage rect from weights image " + weightsId);
      rect = coverageRect(wWin.mainView.image);
   } else {
      log("WARNING: weights image not available — using fixed inset");
   }
   if (!rect)
      rect = fixedInsetRect(W, H);

   log("crop rect: (" + rect.x0 + "," + rect.y0 + ") -> (" + rect.x1 + "," + rect.y1 +
       ")  = " + (rect.x1 - rect.x0) + "x" + (rect.y1 - rect.y0));

   // Crop raises a MODAL "The following items will be deleted as a result of
   // the geometric transformation: Astrometric solution. Proceed?" dialog when
   // the target carries a solution — even under --automation-mode, where it
   // blocks the instance forever (observed 2026-08-07: the blue run hung here
   // until a human clicked). Clear the solution first so there is nothing to
   // warn about; the cropped master gets its WCS transplanted separately from
   // a reference of matching geometry, since Crop cannot carry one across.
   try {
      if (typeof win.clearAstrometricSolution == "function")
         win.clearAstrometricSolution();
   } catch (e) {
      log("  clearAstrometricSolution failed: " + e.message);
   }
   if (win.hasAstrometricSolution) {
      var wcsNames = ["CRPIX1", "CRPIX2", "CRVAL1", "CRVAL2", "CD1_1", "CD1_2",
                      "CD2_1", "CD2_2", "CDELT1", "CDELT2", "CROTA1", "CROTA2",
                      "CTYPE1", "CTYPE2", "RADESYS", "EQUINOX", "PV1_1", "PV1_2"];
      var keep = [];
      var kws = win.keywords;
      for (var q = 0; q < kws.length; ++q) {
         var drop = false;
         for (var z = 0; z < wcsNames.length; ++z)
            if (kws[q].name == wcsNames[z]) { drop = true; break; }
         if (!drop) keep.push(kws[q]);
      }
      win.keywords = keep;
      log("  stripped WCS keywords as fallback; hasAstrometricSolution=" +
          win.hasAstrometricSolution);
   }

   var C = new Crop();
   C.leftMargin   = -rect.x0;
   C.topMargin    = -rect.y0;
   C.rightMargin  = -(W - rect.x1);
   C.bottomMargin = -(H - rect.y1);
   C.mode = Crop.prototype.AbsolutePixels;
   if (!C.executeOn(win.mainView))
      throw new Error("Crop failed");

   log("cropped: " + win.mainView.image.width + "x" + win.mainView.image.height +
       "  hasAstrometricSolution=" + win.hasAstrometricSolution);
   if (!win.hasAstrometricSolution)
      log("  WARNING: crop dropped the astrometric solution — downstream SPCC will fail silently");

   saveWindow(win, outCropPath);

   win.forceClose();
   closeById(weightsId);

   log("done");
   heartbeat("done ok");
}

try {
   main();
} catch (e) {
   log("FATAL: " + e.message);
   heartbeat("fatal");
}
