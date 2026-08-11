// drizzle-optimize.js — headless, per-filter drop-shrink search.
//
// Finds the minimum drizzle drop shrink before grid artifacts appear, by
// binary-searching on the 5th-percentile lag-1 neighbour correlation of
// background tiles (LOW correlation = coverage grid). Detection method,
// thresholds and tiling are UNCHANGED from Dan's validated
// D:/projects/drizzleoptimizer/DrizzleDropShrinkOptimizer.js — see that file
// for the derivation and the Sh2-101 validation series.
//
// jsArguments: [filterDir, outputDir, logPath, resultJsonPath, drizzleScale]
//   filterDir      — ONE WBPP registered/<filter> directory containing .xdrz
//   outputDir      — where the per-drop-shrink FITS go
//   logPath        — log file, written locally (see below)
//   resultJsonPath — written once on success; the driver's completion signal
//   drizzleScale   — integer, e.g. 2
//
// Differences from the original, all deliberate:
//   1. ONE filter per invocation. PixInsight crashed after ~36 consecutive
//      DrizzleIntegrations in a single instance; the driver runs one instance
//      per filter so a crash never loses a finished filter.
//   2. log() mirrors to a file — headless PJSR console output is not captured.
//      Write LOCAL, never to the share: a concurrent reader tailing a
//      per-line-rewritten file over SMB locks it and the run looks dead.
//   3. .xdrz smaller than 20 KB are skipped — registration-only files for
//      minWeight-dropped frames lack the LocationEstimates block and poison
//      DrizzleIntegration.
//   4. enableLocalNormalization is set explicitly, so the search and the final
//      master integrate identically (and match WBPP's own drizzle call).
//   5. executeGlobal is wrapped; results are written as JSON for the driver.
// ES5 only.

var MIN_XDRZ_BYTES = 20 * 1024;

var PARAMS = {
   filterDir:      jsArguments[0],
   outputDir:      jsArguments[1],
   logPath:        jsArguments[2],
   resultJsonPath: jsArguments[3],
   drizzleScale:   parseInt(jsArguments[4], 10),

   // --- unchanged from the validated original ---
   searchMin: 0.20,
   searchMax: 1.00,
   precision: 0.01,
   gridCorrelationThreshold: 0.50,
   corrPercentile: 5,
   tileSize: 128,
   regionFraction: 0.7,
   tileStride: 1,          // MUST be 1: stride>1 aliases onto the 2x grid period
   maxInputFiles: 0,       // 0 = all frames; drop shrink is set by real dither coverage
   saveDrizzleImages: true
};

var statusPath = PARAMS.logPath + ".status";
var RESULTS = [];
var LOG = [];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(msg) {
   console.writeln("[DrizzleOpt] " + msg);
   LOG.push(msg);
   try {
      File.writeTextFile(PARAMS.logPath, LOG.join("\n") + "\n");
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

function ensureDir(path) {
   if (!File.directoryExists(path))
      File.createDirectory(path, true);
}

function parseFilterLabel(folderName) {
   var m = folderName.match(/FILTER-([^_]+(?:_mono|_color)?)/i);
   if (m && m[1])
      return m[1].replace(/_(mono|color)$/i, "");
   return folderName;
}

function dirLeaf(path) {
   var p = path.replace(/[\/\\]+$/, "");
   var slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
   return (slash >= 0) ? p.substring(slash + 1) : p;
}

// ---------------------------------------------------------------------------
// Collect .xdrz files. Only files that carry the LocationEstimates/Weights
// block (~100 KB) are integrable; registration-only stubs are ~1 KB.
// ---------------------------------------------------------------------------
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
   log("Found " + files.length + " usable .xdrz file(s).");
   if (PARAMS.maxInputFiles > 0 && files.length > PARAMS.maxInputFiles) {
      files = files.slice(0, PARAMS.maxInputFiles);
      log("Subsetting to " + files.length + " file(s) as per maxInputFiles.");
   }
   return files;
}

// ---------------------------------------------------------------------------
// Run DrizzleIntegration for a given drop shrink value
// ---------------------------------------------------------------------------
function runDrizzle(xdrzFiles, dropShrink) {
   var D = new DrizzleIntegration();

   D.inputData            = xdrzFiles.map(function(f) { return [true, f]; });
   D.scale                = PARAMS.drizzleScale;
   D.dropShrink           = dropShrink;
   D.kernelFunction       = DrizzleIntegration.prototype.Kernel_Square;
   D.enableRejection      = true;
   D.enableImageWeighting = true;
   D.enableSurfaceSplines = false;
   D.enableLocalNormalization = true;
   D.closePreviousImages  = false;
   D.showImages           = false;
   D.noGUIMessages        = true;

   var result = false;
   try {
      result = D.executeGlobal();
   } catch (e) {
      log("  EXCEPTION in DrizzleIntegration: " + e.message);
      return null;
   }

   if (!result) {
      log("DrizzleIntegration failed for dropShrink=" + dropShrink.toFixed(3));
      return null;
   }

   log("  integrationImageId: " + D.integrationImageId);

   // The weights image is a second window; leaking it across dozens of
   // integrations exhausts memory.
   var weightsId = D.weightImageId;

   var win = ImageWindow.windowById(D.integrationImageId);
   if (!win || win.isNull) {
      log("  WARNING: Could not find integration window by ID, falling back to last window");
      var wins = ImageWindow.windows;
      for (var i = wins.length - 1; i >= 0; i--) {
         if (!wins[i].isNull && wins[i].isNew)
            return { win: wins[i], weightsId: weightsId };
      }
      return null;
   }
   return { win: win, weightsId: weightsId };
}

function closeById(id) {
   if (!id)
      return;
   try {
      var w = ImageWindow.windowById(id);
      if (w && !w.isNull)
         w.forceClose();
   } catch (e) {
   }
}

// ---------------------------------------------------------------------------
// Find the bounding box of non-black pixels in the image
// ---------------------------------------------------------------------------
function findImageBounds(view) {
   var img  = view.image;
   var W    = img.width;
   var H    = img.height;
   var step = 32;

   var minX = W, minY = H, maxX = 0, maxY = 0;

   for (var y = 0; y < H; y += step) {
      for (var x = 0; x < W; x += step) {
         img.selectedRect = new Rect(x, y, x + 1, y + 1);
         if (img.mean() > 1e-6) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
         }
      }
   }
   img.resetSelections();

   var margin = 64;
   minX = Math.min(minX + margin, W);
   minY = Math.min(minY + margin, H);
   maxX = Math.max(maxX - margin, 0);
   maxY = Math.max(maxY - margin, 0);

   log("Image bounds: (" + minX + ", " + minY + ") -> (" + maxX + ", " + maxY + ")");
   return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

// ---------------------------------------------------------------------------
// Save an ImageWindow to disk as FITS
// ---------------------------------------------------------------------------
function saveFits(win, path) {
   var fmt = new FileFormat("FITS", false, true);
   var ffi = new FileFormatInstance(fmt);
   if (ffi.create(path, "")) {
      ffi.writeImage(win.mainView.image);
      ffi.close();
      log("  Saved: " + path);
   } else {
      log("  WARNING: Could not save to " + path);
   }
}

// ---------------------------------------------------------------------------
// Lag-1 neighbour correlation coefficient for one tile
// ---------------------------------------------------------------------------
function tileCorrelation(img, tx, ty, tile, stride) {
   var vals = [];
   var rights = [];
   var downs = [];
   for (var y = ty; y < ty + tile - 1; y += stride) {
      for (var x = tx; x < tx + tile - 1; x += stride) {
         vals.push(  img.sample(x,     y,     0));
         rights.push(img.sample(x + 1, y,     0));
         downs.push( img.sample(x,     y + 1, 0));
      }
   }
   var n = vals.length;
   if (n < 16) return null;

   var sorted = vals.slice().sort(function(a, b) { return a - b; });
   var median = sorted[Math.floor(n / 2)];
   if (median < 1e-4) return null;  // skip black border tiles

   var mv = 0, mr = 0, md = 0;
   for (var i = 0; i < n; i++) { mv += vals[i]; mr += rights[i]; md += downs[i]; }
   mv /= n; mr /= n; md /= n;

   var svr = 0, svv = 0, srr = 0;
   var svd = 0, sdd = 0, svv2 = 0;
   for (var i = 0; i < n; i++) {
      var av = vals[i] - mv;
      var ar = rights[i] - mr;
      var ad = downs[i] - md;
      svr += av * ar;  svv += av * av;  srr += ar * ar;
      svd += av * ad;  sdd += ad * ad;  svv2 += av * av;
   }
   var rh = (svv > 0 && srr > 0) ? svr / Math.sqrt(svv * srr) : 0;
   var rv = (svv2 > 0 && sdd > 0) ? svd / Math.sqrt(svv2 * sdd) : 0;

   return { median: median, corr: (rh + rv) / 2 };
}

// ---------------------------------------------------------------------------
// Measure grid artifact: Nth-percentile tile correlation over ALL tiles
// ---------------------------------------------------------------------------
function measureGridArtifact(win, dropShrink) {
   var img    = win.mainView.image;
   var bounds = findImageBounds(win.mainView);

   var fullW = bounds.x1 - bounds.x0;
   var fullH = bounds.y1 - bounds.y0;
   var regW  = Math.floor(fullW * PARAMS.regionFraction);
   var regH  = Math.floor(fullH * PARAMS.regionFraction);
   var rx0   = bounds.x0 + Math.floor((fullW - regW) / 2);
   var ry0   = bounds.y0 + Math.floor((fullH - regH) / 2);
   var rx1   = rx0 + regW;
   var ry1   = ry0 + regH;

   var tile   = PARAMS.tileSize;
   var stride = PARAMS.tileStride;

   log("  Scan region: (" + rx0 + ", " + ry0 + ") -> (" + rx1 + ", " + ry1 +
       ")  tile=" + tile + " stride=" + stride);

   var tiles = [];
   for (var ty = ry0; ty < ry1 - tile; ty += tile) {
      for (var tx = rx0; tx < rx1 - tile; tx += tile) {
         var t = tileCorrelation(img, tx, ty, tile, stride);
         if (t) tiles.push(t);
      }
   }

   // No measurable tile is NOT clean data. On faint narrowband at a low drop
   // shrink the drizzled background is so full of holes that every tile median
   // falls under the 1e-4 guard — i.e. the worst possible grid. The original
   // script returned 1.0 here ("avoid a false positive"), which reported
   // maximally-gridded halpha as perfectly clean and recommended 0.200.
   // Report it as degenerate and let the caller treat it as grid.
   if (tiles.length === 0) {
      log("  WARNING: no valid tiles found — background entirely below the " +
          "1e-4 median guard; treating as GRID, not clean");
      return { corr: 0, degenerate: true };
   }

   var allCorrs = [];
   for (var i = 0; i < tiles.length; i++) allCorrs.push(tiles[i].corr);
   allCorrs.sort(function(a, b) { return a - b; });

   var idx = Math.floor((PARAMS.corrPercentile / 100) * allCorrs.length);
   if (idx < 0) idx = 0;
   if (idx >= allCorrs.length) idx = allCorrs.length - 1;
   var pctCorr = allCorrs[idx];
   var medCorr = allCorrs[Math.floor(allCorrs.length / 2)];

   log("  tiles=" + tiles.length +
       "  median corr=" + medCorr.toFixed(4) +
       "  p" + PARAMS.corrPercentile + " corr=" + pctCorr.toFixed(4) +
       "  (dropShrink=" + dropShrink.toFixed(3) + ")");

   return { corr: pctCorr, degenerate: false };
}

// ---------------------------------------------------------------------------
// Test a single drop shrink value
// NOTE: gridVisible is TRUE when correlation is BELOW the threshold.
// ---------------------------------------------------------------------------
function testDropShrink(xdrzFiles, dropShrink) {
   log("Testing dropShrink=" + dropShrink.toFixed(3));
   heartbeat("testing dropShrink=" + dropShrink.toFixed(3) + " (" + RESULTS.length + " done)");

   var r = runDrizzle(xdrzFiles, dropShrink);
   if (!r) {
      RESULTS.push({ dropShrink: dropShrink, corr: -1, gridVisible: false, failed: true });
      return { corr: -1, gridVisible: false, failed: true };
   }

   var win = r.win;
   var m = measureGridArtifact(win, dropShrink);
   var corr = m.corr;
   var gridVisible = m.degenerate || (corr < PARAMS.gridCorrelationThreshold);

   if (PARAMS.saveDrizzleImages)
      saveFits(win, PARAMS.outputDir + "/drizzle_" +
               dropShrink.toFixed(3).replace(".", "_") + ".fits");

   var previews = win.previews;
   for (var i = 0; i < previews.length; i++)
      win.deletePreview(previews[i]);
   win.forceClose();
   closeById(r.weightsId);

   RESULTS.push({ dropShrink: dropShrink, corr: corr, gridVisible: gridVisible,
                  failed: false, degenerate: m.degenerate });
   return { corr: corr, gridVisible: gridVisible, failed: false, degenerate: m.degenerate };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function printReport(filterLabel) {
   RESULTS.sort(function(a, b) { return a.dropShrink - b.dropShrink; });

   log("");
   log("============================================================");
   log("  REPORT [" + filterLabel + "] — p" + PARAMS.corrPercentile +
       " tile correlation by drop shrink");
   log("  (LOW correlation = grid present)");
   log("============================================================");
   log("  drop shrink | corr      | status");
   log("  ------------|-----------|----------------");
   for (var i = 0; i < RESULTS.length; i++) {
      var r = RESULTS[i];
      var ds = r.dropShrink.toFixed(3);
      var cc = (r.corr < 0) ? "  FAILED " : r.corr.toFixed(4);
      while (cc.length < 9) cc += " ";
      var status = r.failed ? "drizzle failed" :
                   r.degenerate ? "GRID (unmeasurable)" :
                   (r.gridVisible ? "GRID VISIBLE" : "clean");
      log("     " + ds + "    | " + cc + " | " + status);
   }
   log("============================================================");
}

function writeResult(filterLabel, recommended, note) {
   var obj = {
      filter: filterLabel,
      dir: PARAMS.filterDir,
      scale: PARAMS.drizzleScale,
      recommended: recommended,
      note: note,
      threshold: PARAMS.gridCorrelationThreshold,
      series: RESULTS
   };
   File.writeTextFile(PARAMS.resultJsonPath, JSON.stringify(obj, null, 2));
   log("Result written: " + PARAMS.resultJsonPath);
}

// ---------------------------------------------------------------------------
// Endpoint check + binary search for the one filter
// ---------------------------------------------------------------------------
function main() {
   console.show();
   heartbeat("starting");

   var dirName = dirLeaf(PARAMS.filterDir);
   var filterLabel = parseFilterLabel(dirName);

   log("=== DrizzleDropShrinkOptimizer (single filter) ===");
   log("filterDir:      " + PARAMS.filterDir);
   log("filter:         " + filterLabel);
   log("outputDir:      " + PARAMS.outputDir);
   log("Scale:          " + PARAMS.drizzleScale + "x");
   log("Search range:   " + PARAMS.searchMin + " -> " + PARAMS.searchMax);
   log("Precision:      " + PARAMS.precision);
   log("Corr threshold: " + PARAMS.gridCorrelationThreshold + " (grid if below)");
   log("Tile size:      " + PARAMS.tileSize + "  percentile: p" + PARAMS.corrPercentile);

   if (PARAMS.saveDrizzleImages)
      ensureDir(PARAMS.outputDir);

   var xdrzFiles = collectXdrzFiles(PARAMS.filterDir);

   // Step 1: endpoints
   log("--- Step 1: Testing endpoints ---");
   var verdict = function(r) {
      return r.failed ? " FAILED" :
             r.degenerate ? " GRID (unmeasurable)" :
             (r.gridVisible ? " GRID VISIBLE" : " clean");
   };

   var rMin = testDropShrink(xdrzFiles, PARAMS.searchMin);
   log("  searchMin=" + PARAMS.searchMin + " corr=" + rMin.corr.toFixed(4) + verdict(rMin));
   var rMax = testDropShrink(xdrzFiles, PARAMS.searchMax);
   log("  searchMax=" + PARAMS.searchMax + " corr=" + rMax.corr.toFixed(4) + verdict(rMax));

   // A failed drizzle means DrizzleIntegration could not produce an image. That
   // is NOT clean data, and must never be reported as "clean across full range".
   if (rMin.failed || rMax.failed) {
      log("  ERROR: DrizzleIntegration failed at an endpoint — results are NOT valid.");
      log("         Common cause: .xdrz files lack the LocationEstimates block");
      log("         (regenerate drizzle data in WBPP with Local Normalization on).");
      printReport(filterLabel);
      writeResult(filterLabel, null, "DRIZZLE FAILED — .xdrz not integrable (see log)");
      heartbeat("done failed");
      return;
   }

   if (rMin.gridVisible && rMax.gridVisible) {
      log("  WARNING: grid visible at both endpoints — needs more frames/dither.");
      printReport(filterLabel);
      writeResult(filterLabel, null, "grid at all drop shrinks (>" + PARAMS.searchMax + ")");
      heartbeat("done nogood");
      return;
   }

   if (!rMin.gridVisible && !rMax.gridVisible) {
      log("  No grid detected at either endpoint — data well-sampled.");
      printReport(filterLabel);
      writeResult(filterLabel, PARAMS.searchMin, "clean across full range; min tested");
      heartbeat("done clean");
      return;
   }

   // lo = clean side, hi = grid side (grid appears at SMALLER drop shrink)
   var lo, hi;
   if (rMin.gridVisible) { lo = PARAMS.searchMax; hi = PARAMS.searchMin; }
   else                  { lo = PARAMS.searchMin; hi = PARAMS.searchMax; }

   log("  Threshold between " + lo.toFixed(3) + " (clean) and " + hi.toFixed(3) + " (grid).");

   log("--- Step 2: Binary Search ---");
   var iteration = 0;
   while (Math.abs(hi - lo) > PARAMS.precision) {
      iteration++;
      var mid = Math.round(((lo + hi) / 2) * 1000) / 1000;
      log("  Iter " + iteration + ": mid=" + mid.toFixed(3) +
          " [" + lo.toFixed(3) + " .. " + hi.toFixed(3) + "]");
      var r = testDropShrink(xdrzFiles, mid);
      if (r.failed) {
         log("  ERROR: DrizzleIntegration failed mid-search — aborting this filter.");
         printReport(filterLabel);
         writeResult(filterLabel, null, "DRIZZLE FAILED mid-search at " + mid.toFixed(3));
         heartbeat("done failed");
         return;
      }
      if (r.gridVisible) hi = mid; else lo = mid;
      log("  -> " + (r.gridVisible ? "GRID" : "clean") +
          " corr=" + r.corr.toFixed(4) +
          " [" + Math.min(lo, hi).toFixed(3) + " .. " + Math.max(lo, hi).toFixed(3) + "]");
   }

   var recommended = lo;  // lo is always the clean side

   log("");
   log("  === " + filterLabel + " RESULT ===");
   log("  Recommended drop shrink: " + recommended.toFixed(3) +
       " (grid appears at " + hi.toFixed(3) + ")");

   printReport(filterLabel);
   writeResult(filterLabel, recommended, "");
   heartbeat("done ok");
}

try {
   main();
} catch (e) {
   log("FATAL: " + e.message);
   heartbeat("fatal");
}
