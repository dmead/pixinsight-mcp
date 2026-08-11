// contact-sheet.js — side-by-side auto-STF contact sheet, no-LN vs LN.
//
// jsArguments: [noLnDir, lnDir, outPng, logPath]
//
// One row per filter: left = integrated WITHOUT local normalization, right =
// WITH. Each panel is downsampled (average, on LINEAR data) and then given its
// own auto-STF, exactly as the screen transfer function would show it.
//
// Independent stretches are deliberate: the two versions have different
// medians, and the question is what each looks like when displayed normally.
// A shared stretch would flatter whichever one happens to suit it.
//
// PNG is a VIEWING artifact only — throwaway, written from a headless
// instance. Every measurement in this project is made on the XISF.
// ES5 only.

// PJSR constants live in headers — without these, ImageOp_Mov and
// UndoFlag_NoSwapFile are silently `undefined` (probed 2026-08-07).
#include <pjsr/ImageOp.jsh>
#include <pjsr/UndoFlag.jsh>

var ZOOM = 8;          // downsample factor (6016 -> 752)
var GAP = 12;
var HEADER = 46;
var LABEL = 34;

var noLnDir = jsArguments[0];
var lnDir   = jsArguments[1];
var outPng  = jsArguments[2];
var logPath = jsArguments[3];

var FILTERS = [
   ["lum",    "ds0_807"],
   ["red",    "ds0_813"],
   ["green",  "ds0_819"],
   ["halpha", "ds0_819"],
   ["blue",   "ds0_819"]
];

var LOG = [];
function log(msg) {
   console.writeln("[sheet] " + msg);
   LOG.push(msg);
   // Do NOT swallow logging errors here — a silent log is how the first
   // attempt produced no output at all and no clue why.
   File.writeTextFile(logPath, LOG.join("\n") + "\n");
}

log("script loaded; args=" + jsArguments.length +
    "  ImageOp_Mov=" + ImageOp_Mov + "  UndoFlag_NoSwapFile=" + UndoFlag_NoSwapFile);

function openMain(path) {
   var ws = ImageWindow.open(path);
   if (!ws || ws.length === 0)
      throw new Error("could not open " + path);
   for (var i = 1; i < ws.length; ++i)
      ws[i].forceClose();
   return ws[0];
}

// Standard STF autostretch: shadows clipped at -2.8 sigma, background to 0.25.
function autoStretch(view) {
   var img = view.image;
   var median = img.median();
   var madN = img.MAD() * 1.4826;
   if (madN <= 0) madN = img.stdDev();

   var c0 = median + (-2.80) * madN;
   if (c0 < 0) c0 = 0;
   if (c0 > 1) c0 = 1;
   var m = Math.mtf(0.25, median - c0);

   var H = new HistogramTransformation;
   H.H = [ [0, 0.5, 1, 0, 1],
           [0, 0.5, 1, 0, 1],
           [0, 0.5, 1, 0, 1],
           [c0, m, 1, 0, 1],     // index 3 = the RGB/K channel
           [0, 0.5, 1, 0, 1] ];
   H.executeOn(view);
   return { c0: c0, m: m, median: median };
}

// Load, downsample on linear data, then auto-STF. Returns the window.
function panel(path) {
   var w = openMain(path);

   var R = new IntegerResample;
   R.zoomFactor = -ZOOM;
   R.downsamplingMode = IntegerResample.prototype.Average;
   R.executeOn(w.mainView);

   var stf = autoStretch(w.mainView);
   log("   " + path.replace(/.*\//, "") + "  -> " +
       w.mainView.image.width + "x" + w.mainView.image.height +
       "  median=" + stf.median.toFixed(6) +
       "  c0=" + stf.c0.toFixed(6) + "  m=" + stf.m.toFixed(4));
   return w;
}

function main() {
   log("=== contact sheet: no-LN vs LN ===");

   // Size the sheet from the first pair.
   var probe = panel(noLnDir + "/" + FILTERS[0][0] + "_drizzle2x_" + FILTERS[0][1] + ".xisf");
   var tw = probe.mainView.image.width, th = probe.mainView.image.height;
   probe.forceClose();

   var sheetW = GAP + tw + GAP + tw + GAP;
   var sheetH = HEADER + FILTERS.length * (LABEL + th + GAP);
   log("tile " + tw + "x" + th + "   sheet " + sheetW + "x" + sheetH);

   var mw = new ImageWindow(sheetW, sheetH, 1, 32, true, false, "contact_sheet");
   var mimg = mw.mainView.image;
   mw.mainView.beginProcess(UndoFlag_NoSwapFile);
   mimg.fill(0.10);   // dark grey surround

   var rowTops = [];
   for (var i = 0; i < FILTERS.length; ++i) {
      var name = FILTERS[i][0] + "_drizzle2x_" + FILTERS[i][1] + ".xisf";
      var top = HEADER + i * (LABEL + th + GAP) + LABEL;
      rowTops.push(top);
      log(FILTERS[i][0] + ":");

      var pair = [noLnDir + "/" + name, lnDir + "/" + name];
      for (var c = 0; c < 2; ++c) {
         var p = null;
         try {
            p = panel(pair[c]);
            var x = GAP + c * (tw + GAP);
            mimg.selectedPoint = new Point(x, top);
            mimg.apply(p.mainView.image, ImageOp_Mov);
            mimg.resetSelections();
         } catch (e) {
            log("   MISSING/ERROR " + pair[c] + ": " + e.message);
         }
         if (p) p.forceClose();
      }
   }

   // Labels. Non-fatal: a sheet without text still answers the question.
   try {
      var bmp = new Bitmap(sheetW, sheetH);
      bmp.fill(0x00000000);
      var g = new Graphics(bmp);
      g.transparentBackground = true;
      g.pen = new Pen(0xffffffff);

      g.font = new Font("Helvetica", 26);
      g.font.bold = true;
      g.drawText(GAP, HEADER - 16, "M81/M82 masters — LEFT: no local normalization    RIGHT: with local normalization   (auto-STF, independent per panel)");

      g.font = new Font("Helvetica", 22);
      for (var i = 0; i < FILTERS.length; ++i) {
         var y = rowTops[i] - 10;
         g.drawText(GAP, y, FILTERS[i][0] + "  (" +
                    FILTERS[i][1].replace("ds", "drop shrink ").replace("_", ".") + ")   — no LN");
         g.drawText(GAP + tw + GAP, y, FILTERS[i][0] + "   — with LN");
      }
      g.end();
      mimg.blend(bmp);
      log("labels drawn");
   } catch (e) {
      log("labels skipped: " + e.message);
   }

   mw.mainView.endProcess();

   if (!mw.saveAs(outPng, false, false, false, false))
      throw new Error("saveAs failed: " + outPng);
   log("Saved: " + outPng);
   mw.forceClose();
   log("done");
}

try {
   main();
} catch (e) {
   log("FATAL: " + e.message);
}
