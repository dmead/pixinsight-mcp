// superlum.js — synthetic luminance from all broadband masters.
//
// jsArguments: [outPath, logPath, refPath, otherPath1, otherPath2, ...]
//   refPath    — the master everything else is fitted TO (use lum: deepest)
//   otherPath* — the remaining broadband masters (red, green, blue)
//
// The masters share a single global registration reference frame
// (bestFrameReferenceMethod=1), so they are pixel-aligned and can be combined
// directly. Two steps matter:
//
//   1. LinearFit each channel to the reference. The filters have different
//      throughputs and sky levels; averaging them raw would let the brightest
//      dominate and would leave the background levels inconsistent.
//   2. Noise-weighted average. Weighting by 1/noise^2 is the SNR-optimal
//      combination — a straight mean would let the noisiest channel drag the
//      result down. Weights are reported in the log.
//
// Halpha is deliberately NOT included: a narrowband channel in a synthetic
// luminance injects emission structure into what should be a broadband
// brightness reference.
//
// The result keeps the reference's astrometric solution (identical geometry).
// ES5 only.

var outPath = jsArguments[0];
var logPath = jsArguments[1];
var refPath = jsArguments[2];
var others = [];
for (var a = 3; a < jsArguments.length; ++a)
   others.push(jsArguments[a]);

var statusPath = logPath + ".status";
var LOG = [];

function log(msg) {
   console.writeln("[superlum] " + msg);
   LOG.push(msg);
   File.writeTextFile(logPath, LOG.join("\n") + "\n");
}
function heartbeat(msg) {
   try { File.writeTextFile(statusPath, msg); } catch (e) {}
}

function openMain(path) {
   var ws = ImageWindow.open(path);
   if (!ws || ws.length === 0)
      throw new Error("could not open " + path);
   for (var i = 1; i < ws.length; ++i)
      ws[i].forceClose();
   return ws[0];
}

// Robust noise estimate: MAD of the image, normalized to sigma.
function noiseOf(img) {
   var mad = img.MAD() * 1.4826;
   if (!(mad > 0)) mad = img.stdDev();
   return mad;
}

function main() {
   heartbeat("starting");
   log("=== superlum ===");
   log("reference: " + refPath);
   for (var i = 0; i < others.length; ++i)
      log("  + " + others[i]);

   var ref = openMain(refPath);
   var W = ref.mainView.image.width, H = ref.mainView.image.height;
   log("geometry: " + W + "x" + H + "  hasAstrometricSolution=" + ref.hasAstrometricSolution);

   var wins = [ref];
   var ids = [ref.mainView.id];

   // ---- LinearFit every other channel to the reference ----
   heartbeat("linear fit");
   for (var i = 0; i < others.length; ++i) {
      var w = openMain(others[i]);
      if (w.mainView.image.width != W || w.mainView.image.height != H)
         throw new Error("geometry mismatch: " + others[i] + " is " +
                         w.mainView.image.width + "x" + w.mainView.image.height);
      var LF = new LinearFit;
      LF.referenceViewId = ref.mainView.id;
      LF.rejectLow = 0.0;
      LF.rejectHigh = 0.92;
      if (!LF.executeOn(w.mainView))
         throw new Error("LinearFit failed for " + others[i]);
      log("  fitted " + w.mainView.id + " -> " + ref.mainView.id);
      wins.push(w);
      ids.push(w.mainView.id);
   }

   // ---- noise weights ----
   var weights = [], total = 0;
   for (var i = 0; i < wins.length; ++i) {
      var n = noiseOf(wins[i].mainView.image);
      var wgt = (n > 0) ? 1.0 / (n * n) : 0;
      weights.push(wgt);
      total += wgt;
      log("  " + ids[i] + "  noise=" + n.toExponential(3) + "  weight=" + wgt.toExponential(3));
   }
   if (!(total > 0))
      throw new Error("all weights are zero");
   for (var i = 0; i < weights.length; ++i)
      weights[i] /= total;
   log("normalized weights: " + weights.map(function (x) { return x.toFixed(4); }).join(", "));

   // ---- weighted sum via PixelMath ----
   heartbeat("combining");
   var terms = [];
   for (var i = 0; i < ids.length; ++i)
      terms.push(weights[i].toFixed(8) + "*" + ids[i]);
   var expr = terms.join(" + ");
   log("expression: " + expr);

   var PM = new PixelMath;
   PM.expression = expr;
   PM.useSingleExpression = true;
   PM.createNewImage = true;
   PM.newImageId = "superlum";
   PM.newImageColorSpace = PixelMath.prototype.Gray;
   PM.newImageSampleFormat = PixelMath.prototype.f32;
   PM.rescale = false;             // preserve levels; rescaling would undo the fit
   PM.truncate = false;
   if (!PM.executeOn(ref.mainView))
      throw new Error("PixelMath failed");

   var out = ImageWindow.windowById("superlum");
   if (!out || out.isNull)
      throw new Error("superlum window not found");

   // ---- astrometry: identical geometry, so the solution transplants exactly ----
   if (ref.hasAstrometricSolution) {
      out.copyAstrometricSolution(ref);
      log("astrometry copied; hasAstrometricSolution=" + out.hasAstrometricSolution);
   } else {
      log("WARNING: reference has no astrometric solution to copy");
   }
   var rKW = ref.keywords, tKW = out.keywords;
   var names = ["DATE-OBS", "TELESCOP", "INSTRUME", "OBJECT", "FOCALLEN",
                "XPIXSZ", "YPIXSZ", "RA", "DEC", "OBJCTRA", "OBJCTDEC"];
   for (var k = 0; k < names.length; ++k)
      for (var m = 0; m < rKW.length; ++m)
         if (rKW[m].name == names[k]) {
            tKW.push(new FITSKeyword(rKW[m].name, rKW[m].value, rKW[m].comment));
            break;
         }
   tKW.push(new FITSKeyword("FILTER", "'superlum'", "synthetic broadband luminance"));
   tKW.push(new FITSKeyword("HISTORY", "", "superlum = noise-weighted mean of LinearFit'd " +
                            ids.join("+")));
   out.keywords = tKW;

   var img = out.mainView.image;
   log("result: " + img.width + "x" + img.height +
       "  median=" + img.median().toFixed(6) +
       "  noise=" + noiseOf(img).toExponential(3));

   if (!out.saveAs(outPath, false, false, false, false))
      throw new Error("saveAs failed: " + outPath);
   log("Saved: " + outPath);

   out.forceClose();
   for (var i = 0; i < wins.length; ++i)
      wins[i].forceClose();

   log("done");
   heartbeat("done ok");
}

try {
   main();
} catch (e) {
   log("FATAL: " + e.message);
   heartbeat("fatal");
}
