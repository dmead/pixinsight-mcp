// measure-subs.js — headless sub-frame quality measurement.
//
// jsArguments: [listPath, csvPath, logPath, ("probe")]
//   listPath — text file, one absolute XISF path per line (no commas/quotes)
//   csvPath  — output CSV (rewritten as rows accumulate)
//   logPath  — log file (headless console output is not captured); a
//              heartbeat status file is written at logPath + ".status"
//   probe    — optional: dump SubframeSelector.toSource() and the raw first
//              measurement row, for pinning column indices
//
// Measures each sub with SubframeSelector.MeasureSubframes in batches (so a
// crash loses at most one batch), then computes a 5-box gradient metric
// (4 corners at 15% inset + center, 256px boxes, medians via selectedRect).
// ES5 only.

// ---- measurement row column indices, pinned from the 2026-07-18 probe run
// (PI 1.9.x): index, enabled, locked, filePath, weight, FWHM, eccentricity,
// PSFSignalWeight, unused01, SNRWeight, median, medianMeanDev, noise,
// noiseRatio, stars, starResidual, ... azimuth(19), altitude(20), ... ----
var COL_ENABLED = 1;
var COL_PATH = 3;
var COL_WEIGHT = 4;
var COL_FWHM = 5;
var COL_ECC = 6;
var COL_PSF_SIGNAL = 7;
var COL_SNR = 9;
var COL_MEDIAN = 10;
var COL_NOISE = 12;
var COL_STARS = 14;

var BATCH_SIZE = 25;
var BOX = 256;
var INSET_FRAC = 0.15;

var listPath = jsArguments[0];
var csvPath = jsArguments[1];
var logPath = jsArguments[2];
var probeMode = (jsArguments.length > 3 && jsArguments[3] == "probe");
var statusPath = logPath + ".status";

var LOG = [];

function log(msg) {
   LOG.push("[" + (new Date()).toISOString() + "] " + msg);
   try {
      File.writeTextFile(logPath, LOG.join("\n") + "\n");
   } catch (e) {
      // never let logging kill the run
   }
}

function heartbeat(msg) {
   try {
      File.writeTextFile(statusPath, msg);
   } catch (e) {
   }
}

function readList(path) {
   var lines = File.readLines(path);
   var out = [];
   for (var i = 0; i < lines.length; ++i) {
      var s = lines[i].trim();
      if (s.length > 0)
         out.push(s);
   }
   return out;
}

function normKey(path) {
   return path.toLowerCase().replace(/\\/g, "/");
}

// ---- pass 1: SubframeSelector measurement of one batch ----
function measureBatch(paths) {
   var P = new SubframeSelector;
   P.routine = SubframeSelector.prototype.MeasureSubframes;
   if (typeof P.nonInteractive != "undefined")
      P.nonInteractive = true;
   if (typeof P.fileCache != "undefined")
      P.fileCache = true;
   var subs = [];
   for (var i = 0; i < paths.length; ++i)
      subs.push([true, paths[i]]);
   P.subframes = subs;
   var ok = P.executeGlobal();
   if (!ok)
      throw new Error("MeasureSubframes executeGlobal() returned false");
   if (P.measurements.length != paths.length)
      log("WARNING: measured " + P.measurements.length + " of " +
          paths.length + " subs in batch (unreadable/starless frames?)");

   if (probeMode) {
      log("PROBE toSource: " + P.toSource());
      if (P.measurements.length > 0)
         log("PROBE row0: " + JSON.stringify(P.measurements[0]));
   }

   var map = {};
   for (var r = 0; r < P.measurements.length; ++r) {
      var row = P.measurements[r];
      var p = row[COL_PATH];
      if (typeof p != "string" || p.toLowerCase().indexOf(".xisf") < 0)
         throw new Error("Column mapping broken: COL_PATH=" + COL_PATH +
                         " is not a path: " + p);
      var m = {
         weight: row[COL_WEIGHT],
         fwhm: row[COL_FWHM],
         ecc: row[COL_ECC],
         snr: row[COL_SNR],
         median: row[COL_MEDIAN],
         noise: row[COL_NOISE],
         stars: row[COL_STARS],
         psfSignal: row[COL_PSF_SIGNAL]
      };
      if (!(m.fwhm > 0.3 && m.fwhm < 30))
         throw new Error("Column mapping suspect: FWHM=" + m.fwhm +
                         " for " + p);
      if (!(m.ecc >= 0 && m.ecc <= 1))
         throw new Error("Column mapping suspect: ecc=" + m.ecc +
                         " for " + p);
      if (!(m.median > 0 && m.median < 1))
         throw new Error("Column mapping suspect: median=" + m.median +
                         " for " + p);
      if (!(m.stars >= 0 && m.stars == Math.floor(m.stars)))
         throw new Error("Column mapping suspect: stars=" + m.stars +
                         " for " + p);
      map[normKey(p)] = m;
   }
   return map;
}

// ---- pass 2: 5-box gradient metric ----
function gradientMetric(path) {
   var wins = ImageWindow.open(path);
   if (wins.length == 0)
      throw new Error("Cannot open " + path);
   // XISF files can open with crop_mask windows — keep [0], close the rest
   for (var i = 1; i < wins.length; ++i)
      wins[i].forceClose();
   var w = wins[0];
   try {
      var img = w.mainView.image;
      var W = img.width, H = img.height;
      var ix = Math.round(W * INSET_FRAC);
      var iy = Math.round(H * INSET_FRAC);
      var boxes = [
         [ix, iy],                          // TL
         [W - ix - BOX, iy],                // TR
         [ix, H - iy - BOX],                // BL
         [W - ix - BOX, H - iy - BOX],      // BR
         [Math.round((W - BOX) / 2), Math.round((H - BOX) / 2)]  // C
      ];
      var med = [];
      for (var b = 0; b < boxes.length; ++b) {
         var x0 = boxes[b][0], y0 = boxes[b][1];
         img.selectedRect = new Rect(x0, y0, x0 + BOX, y0 + BOX);
         med.push(img.median());
      }
      img.resetSelections();
      var mn = med[0], mx = med[0];
      for (var k = 1; k < med.length; ++k) {
         if (med[k] < mn) mn = med[k];
         if (med[k] > mx) mx = med[k];
      }
      var center = med[4];
      return {
         spread: (mx - mn) / Math.max(center, 1e-6),
         boxes: med
      };
   } finally {
      w.forceClose();
   }
}

function fmt(v) {
   if (typeof v != "number" || !isFinite(v))
      return "";
   return v.toPrecision(8);
}

function writeCsv(rows) {
   var lines = ["path,fwhmPx,eccentricity,median,noise,starCount," +
                "psfSignalWeight,snrWeight,gradientSpread," +
                "boxTL,boxTR,boxBL,boxBR,boxC"];
   for (var i = 0; i < rows.length; ++i) {
      var r = rows[i];
      lines.push('"' + r.path + '",' + fmt(r.fwhm) + "," + fmt(r.ecc) + "," +
                 fmt(r.median) + "," + fmt(r.noise) + "," + r.stars + "," +
                 fmt(r.psfSignal) + "," + fmt(r.snr) + "," + fmt(r.spread) + "," +
                 fmt(r.boxes[0]) + "," + fmt(r.boxes[1]) + "," +
                 fmt(r.boxes[2]) + "," + fmt(r.boxes[3]) + "," + fmt(r.boxes[4]));
   }
   File.writeTextFile(csvPath, lines.join("\n") + "\n");
}

function main() {
   var paths = readList(listPath);
   log("measure-subs start: " + paths.length + " subs, probe=" + probeMode);
   heartbeat("start 0/" + paths.length);

   var rows = [];
   var done = 0;
   for (var b0 = 0; b0 < paths.length; b0 += BATCH_SIZE) {
      var batch = paths.slice(b0, Math.min(b0 + BATCH_SIZE, paths.length));
      heartbeat("measure batch@" + b0 + " " + done + "/" + paths.length);
      log("batch " + b0 + ": measuring " + batch.length + " subs");
      var map = measureBatch(batch);
      for (var i = 0; i < batch.length; ++i) {
         var key = normKey(batch[i]);
         var m = map[key];
         if (!m) {
            log("WARNING: no measurement for " + batch[i] + " — skipping");
            continue;
         }
         var g = gradientMetric(batch[i]);
         rows.push({
            path: batch[i],
            fwhm: m.fwhm, ecc: m.ecc, median: m.median, noise: m.noise,
            stars: m.stars, psfSignal: m.psfSignal, snr: m.snr,
            spread: g.spread, boxes: g.boxes
         });
         ++done;
         if (done % 10 == 0) {
            writeCsv(rows);
            heartbeat("gradient " + done + "/" + paths.length);
         }
         if (done % 25 == 0)
            gc();
      }
      writeCsv(rows);
      heartbeat("batch-done " + done + "/" + paths.length);
   }

   writeCsv(rows);
   heartbeat("done " + rows.length + "/" + paths.length);
   log("DONE " + rows.length + " rows");
}

try {
   main();
} catch (e) {
   log("FATAL: " + e);
   heartbeat("fatal");
}
