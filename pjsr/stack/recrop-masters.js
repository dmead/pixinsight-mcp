// recrop-masters.js — re-crop a final drizzle master to WBPP's own autocrop
// rectangle and give it back a VALID astrometric solution.
//
// jsArguments: [wbppFull, wbppCrop, myFull, outPath, logPath]
//   wbppFull — WBPP master/..._drizzle_2x.xisf         (full frame, plate solved)
//   wbppCrop — WBPP master/..._drizzle_2x_autocrop.xisf (cropped, plate solved)
//   myFull   — our final master at the optimized drop shrink (full frame)
//   outPath  — cropped output
//
// Why this exists: Crop DELETES the astrometric solution (PixInsight even
// raises a modal "the following items will be deleted: Astrometric solution"
// that blocks a headless instance). So a cropped master can only get a WCS by
// transplant from a reference of IDENTICAL geometry — and the only such
// reference is WBPP's own autocrop master. Therefore we must crop to exactly
// WBPP's rectangle, not to a rectangle of our own choosing.
//
// The rectangle is recovered from the two WBPP masters' reference pixels:
// cropping by (x0,y0) shifts CRPIX by the same amount. FITS counts rows from
// the BOTTOM, so the top offset is (H-h) - (CRPIX2_full - CRPIX2_crop).
//
// The derived rectangle is VERIFIED before use: the same region sampled out of
// WBPP's full master must have statistics identical to WBPP's autocrop master
// (both come from the same integration, so they must match exactly). If they
// do not, the script aborts rather than write a misaligned master.
// ES5 only.

var wbppFull = jsArguments[0];
var wbppCrop = jsArguments[1];
var myFull   = jsArguments[2];
var outPath  = jsArguments[3];
var logPath  = jsArguments[4];

var statusPath = logPath + ".status";
var LOG = [];

function log(msg) {
   console.writeln("[recrop] " + msg);
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

// Open an XISF and return the main window, closing the extra windows that XISF
// files bring with them (crop_mask, rejection maps).
function openMain(path) {
   var ws = ImageWindow.open(path);
   if (!ws || ws.length === 0)
      throw new Error("could not open " + path);
   for (var i = 1; i < ws.length; ++i)
      ws[i].forceClose();
   return ws[0];
}

function keywordValue(win, name) {
   var kw = win.keywords;
   for (var i = 0; i < kw.length; ++i)
      if (kw[i].name == name)
         return parseFloat(kw[i].value);
   return NaN;
}

// Reference pixel of an astrometric solution, in PI image coordinates
// (origin top-left, y increasing downward). Prefers the XISF property; falls
// back to CRPIX keywords, converting from the FITS bottom-up row convention.
function refPixel(win, propId, kx, ky, height) {
   try {
      var v = win.mainView.propertyValue(propId);
      if (v != null && typeof v.at == "function")
         return { x: v.at(0), y: v.at(1), source: "XISF property" };
   } catch (e) {
   }
   var cx = keywordValue(win, kx), cy = keywordValue(win, ky);
   if (isNaN(cx) || isNaN(cy))
      throw new Error("no astrometric reference pixel (neither " + propId +
                      " nor " + kx + "/" + ky + ")");
   return { x: cx, y: height - cy, source: "FITS keywords" };
}

// Remove the astrometric solution so Crop has nothing to warn about.
function clearWcs(win) {
   try {
      if (typeof win.clearAstrometricSolution == "function")
         win.clearAstrometricSolution();
   } catch (e) {
      log("  clearAstrometricSolution failed: " + e.message);
   }
   if (win.hasAstrometricSolution) {
      var drop = ["CRPIX1", "CRPIX2", "CRVAL1", "CRVAL2", "CD1_1", "CD1_2",
                  "CD2_1", "CD2_2", "CDELT1", "CDELT2", "CROTA1", "CROTA2",
                  "CTYPE1", "CTYPE2", "RADESYS", "EQUINOX"];
      var keep = [], kws = win.keywords;
      for (var i = 0; i < kws.length; ++i) {
         var skip = false;
         for (var j = 0; j < drop.length; ++j)
            if (kws[i].name == drop[j]) { skip = true; break; }
         if (!skip) keep.push(kws[i]);
      }
      win.keywords = keep;
   }
}

function cropTo(win, rect) {
   var W = win.mainView.image.width, H = win.mainView.image.height;
   clearWcs(win);
   var C = new Crop();
   C.mode = Crop.prototype.AbsolutePixels;
   C.leftMargin   = -rect.x0;
   C.topMargin    = -rect.y0;
   C.rightMargin  = -(W - rect.x1);
   C.bottomMargin = -(H - rect.y1);
   if (!C.executeOn(win.mainView))
      throw new Error("Crop failed");
}

function main() {
   heartbeat("starting");
   log("=== recrop-masters ===");
   log("wbppFull: " + wbppFull);
   log("wbppCrop: " + wbppCrop);
   log("myFull:   " + myFull);

   var wf = openMain(wbppFull);
   var wc = openMain(wbppCrop);

   var W = wf.mainView.image.width,  H = wf.mainView.image.height;
   var w = wc.mainView.image.width,  h = wc.mainView.image.height;
   log("WBPP full: " + W + "x" + H + " (hasAstro=" + wf.hasAstrometricSolution + ")");
   log("WBPP crop: " + w + "x" + h + " (hasAstro=" + wc.hasAstrometricSolution + ")");

   if (!wc.hasAstrometricSolution)
      throw new Error("WBPP autocrop master has no astrometric solution — nothing to transplant");

   // PixInsight stores the solution as XISF PROPERTIES, not FITS keywords —
   // these masters have no CRPIX at all. ReferenceImageCoordinates is the
   // reference pixel in PI image coordinates (origin top-left, y down), so the
   // crop offset is a plain difference with no FITS row-flip to get wrong.
   var refProp = "PCL:AstrometricSolution:ReferenceImageCoordinates";
   var vf = refPixel(wf, refProp, "CRPIX1", "CRPIX2", H);
   var vc = refPixel(wc, refProp, "CRPIX1", "CRPIX2", h);
   log("reference pixel  full: " + vf.x.toFixed(3) + ", " + vf.y.toFixed(3) +
       "   crop: " + vc.x.toFixed(3) + ", " + vc.y.toFixed(3) +
       "   (source: " + vf.source + ")");

   var x0 = Math.round(vf.x - vc.x);
   var y0 = Math.round(vf.y - vc.y);
   var rect = { x0: x0, y0: y0, x1: x0 + w, y1: y0 + h };
   log("derived rect: (" + rect.x0 + "," + rect.y0 + ") -> (" + rect.x1 + "," + rect.y1 +
       ")  = " + w + "x" + h);

   if (x0 < 0 || y0 < 0 || rect.x1 > W || rect.y1 > H)
      throw new Error("derived rectangle falls outside the full frame");

   // ---- verify the rectangle against WBPP's own data ----
   // Both WBPP masters come from the SAME integration, so the derived region of
   // the full master must be PIXEL-IDENTICAL to the autocrop master.
   //
   // Region statistics (median/mean) are useless for this: on a mostly-sky
   // field they barely move even under a 100 px shift. Compare actual pixel
   // values on a sampling grid instead — a one-pixel error lands star cores
   // against background and shows up immediately.
   //
   // The reference pixels are fractional, so the rounded offset can be off by
   // one; search a small neighbourhood and take the exact match.
   var imgF = wf.mainView.image;
   var imgC = wc.mainView.image;
   var STEP = 97;          // coprime with the frame size — avoids sampling a lattice
   // Wide enough that the optimum is provably INTERIOR. The WCS-derived offset
   // turned out to be several px off in y, and a minimum sitting on the search
   // boundary is not a minimum — it is a truncated search.
   var SEARCH = 8;

   // Sample STARS, not sky. A uniform grid lands almost entirely on featureless
   // background, where an 8 px shift changes nothing — the cost surface comes
   // out flat and the "best" offset is noise (measured: runner-up scored 1.0x
   // the best). High-contrast pixels make a one-pixel error unmistakable.
   // Scan the central half densely — the galaxies live there and supply plenty
   // of structure — then rank by brightness. A sparse grid over the whole frame
   // finds almost no star cores (measured: 67 above median+6sigma at step 13).
   var cMedian = imgC.median(), cSigma = imgC.stdDev();
   var qx = Math.floor(w * 0.25), qy = Math.floor(h * 0.25);
   var ex = Math.floor(w * 0.75), ey = Math.floor(h * 0.75);

   var cand = [];
   for (var sy = qy; sy < ey; sy += 6)
      for (var sx = qx; sx < ex; sx += 6) {
         var v = imgC.sample(sx, sy, 0);
         if (v > cMedian + 2 * cSigma)
            cand.push([sx, sy, v]);
      }
   cand.sort(function(a, b) { return b[2] - a[2]; });   // brightest first

   var MAX_SAMPLES = 1200;
   var samples = cand.slice(0, MAX_SAMPLES);
   log("high-contrast samples: " + samples.length + " of " + cand.length +
       " candidates above median+2sigma");
   if (samples.length < 100)
      throw new Error("too few high-contrast samples (" + samples.length +
                      ") to verify alignment");

   var best = null, second = null;
   for (var dy = -SEARCH; dy <= SEARCH; ++dy) {
      for (var dx = -SEARCH; dx <= SEARCH; ++dx) {
         var ox = rect.x0 + dx, oy = rect.y0 + dy;
         if (ox < 0 || oy < 0 || ox + w > W || oy + h > H)
            continue;
         var sum = 0;
         for (var s = 0; s < samples.length; ++s)
            sum += Math.abs(imgF.sample(ox + samples[s][0], oy + samples[s][1], 0) -
                            imgC.sample(samples[s][0], samples[s][1], 0));
         var mad = sum / samples.length;
         var cand = { dx: dx, dy: dy, mad: mad };
         if (best === null || mad < best.mad) { second = best; best = cand; }
         else if (second === null || mad < second.mad) { second = cand; }
      }
   }

   log("best offset: derived" + (best.dx || best.dy ?
       " + (" + best.dx + "," + best.dy + ")" : " exactly") +
       "   mean|diff| = " + best.mad.toExponential(3));
   log("runner-up: (" + second.dx + "," + second.dy + ")  mean|diff| = " +
       second.mad.toExponential(3) + "   ratio = " + (second.mad / best.mad).toFixed(1) + "x");

   // A boundary optimum means the search was truncated, not that a minimum was
   // found. Refuse rather than crop to a guess.
   if (Math.abs(best.dx) >= SEARCH || Math.abs(best.dy) >= SEARCH)
      throw new Error("best offset (" + best.dx + "," + best.dy + ") sits on the +/-" +
                      SEARCH + " search boundary — widen SEARCH; not a proven minimum");

   // WBPP's autocrop sits at a FRACTIONAL offset and interpolates (its stdDev
   // runs ~6% below the same region of the full master — interpolation smooths),
   // so an integer crop cannot match it bit-for-bit. Gate on the image's own
   // noise instead: a correctly aligned integer crop lands far below it, while
   // a misaligned one lands at ~1.1x sigma because star cores fall on
   // background. The leftover error is the sub-pixel part of the offset only.
   // The alignment must be a SHARP minimum, not the low point of a flat plain:
   // on star pixels a correct offset scores far better than any neighbour.
   // Requiring a clear margin over the runner-up is what catches a flat (i.e.
   // uninformative) cost surface.
   var MIN_RATIO = 3.0;
   var ratio = second ? (second.mad / best.mad) : 0;
   if (ratio < MIN_RATIO)
      throw new Error("alignment is not a sharp minimum (runner-up only " +
                      ratio.toFixed(2) + "x worse, need " + MIN_RATIO +
                      "x) — the match is not discriminating; refusing to crop");

   var subX = Math.abs((vf.x - vc.x) - Math.round(vf.x - vc.x));
   var subY = Math.abs((vf.y - vc.y) - Math.round(vf.y - vc.y));
   log("sub-pixel registration residual vs the transplanted solution: " +
       subX.toFixed(3) + ", " + subY.toFixed(3) + " px (negligible for SPCC/annotation)");

   rect.x0 += best.dx; rect.x1 += best.dx;
   rect.y0 += best.dy; rect.y1 += best.dy;
   log("rectangle VERIFIED pixel-for-pixel: (" + rect.x0 + "," + rect.y0 + ") -> (" +
       rect.x1 + "," + rect.y1 + ")");

   wf.forceClose();

   // ---- apply to our master ----
   heartbeat("cropping");
   var mine = openMain(myFull);
   var mw = mine.mainView.image.width, mh = mine.mainView.image.height;
   log("our master: " + mw + "x" + mh + " (hasAstro=" + mine.hasAstrometricSolution + ")");
   if (mw != W || mh != H)
      throw new Error("our master is " + mw + "x" + mh + " but WBPP's full is " + W + "x" + H);

   cropTo(mine, rect);
   log("cropped to " + mine.mainView.image.width + "x" + mine.mainView.image.height);

   // ---- transplant the solution from the geometry-matched reference ----
   mine.copyAstrometricSolution(wc);
   log("astrometry transplanted; hasAstrometricSolution=" + mine.hasAstrometricSolution);
   if (!mine.hasAstrometricSolution)
      throw new Error("transplant did not take — refusing to write a WCS-less master");

   wc.forceClose();

   if (!mine.saveAs(outPath, false, false, false, false))
      throw new Error("saveAs failed: " + outPath);
   log("Saved: " + outPath);
   mine.forceClose();

   log("done");
   heartbeat("done ok");
}

try {
   main();
} catch (e) {
   log("FATAL: " + e.message);
   heartbeat("fatal");
}
