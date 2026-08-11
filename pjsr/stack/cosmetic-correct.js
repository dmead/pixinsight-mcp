// cosmetic-correct.js — headless CosmeticCorrection (auto sigma) over a file list.
//
// jsArguments: [listPath, outDir, logPath]
//   listPath — text file, one absolute XISF path per line (no commas/quotes)
//   outDir   — destination for the corrected frames (<basename>_cc.xisf)
//   logPath  — log file (headless console output is not captured); a heartbeat
//              status file is written at logPath + ".status"
//
// Runs auto-detect hot AND cold pixel correction with no master dark. This is
// the fix for hot pixels that recur at the same SKY position through dither
// gaps — per-pixel rejection at integration time cannot catch those, and on
// M82 they survived into the masters as single-channel spikes.
//
// Idempotent: inputs whose output already exists are skipped, so a killed run
// resumes where it stopped. Batched so a crash loses at most one batch.
// ES5 only.

var BATCH_SIZE = 40;
var HOT_SIGMA = 3.0;
var COLD_SIGMA = 3.0;

var listPath = jsArguments[0];
var outDir = jsArguments[1];
var logPath = jsArguments[2];
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

function baseName(path) {
   var slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
   var name = (slash >= 0) ? path.substring(slash + 1) : path;
   var dot = name.lastIndexOf(".");
   return (dot > 0) ? name.substring(0, dot) : name;
}

function outputFor(path) {
   return outDir + "/" + baseName(path) + "_cc.xisf";
}

function correctBatch(paths) {
   var P = new CosmeticCorrection;

   var targets = [];
   for (var i = 0; i < paths.length; ++i)
      targets.push([true, paths[i]]);
   P.targetFrames = targets;

   P.outputDir = outDir;
   P.outputExtension = ".xisf";
   P.prefix = "";
   P.postfix = "_cc";
   P.overwrite = true;
   P.amount = 1.0;
   P.cfa = false;

   // No master dark available — these frames are already calibrated.
   P.useMasterDark = false;
   P.hotDarkCheck = false;
   P.coldDarkCheck = false;
   P.useDefectList = false;

   // Auto-detect: sigma clipping against the frame's own statistics.
   P.useAutoDetect = true;
   P.hotAutoCheck = true;
   P.hotAutoValue = HOT_SIGMA;
   P.coldAutoCheck = true;
   P.coldAutoValue = COLD_SIGMA;

   return P.executeGlobal();
}

function main() {
   heartbeat("starting");
   log("=== cosmetic-correct ===");
   log("list:   " + listPath);
   log("outDir: " + outDir);
   log("auto-detect hot " + HOT_SIGMA + " sigma, cold " + COLD_SIGMA + " sigma, no master dark");

   if (!File.directoryExists(outDir))
      File.createDirectory(outDir, true);

   var all = readList(listPath);
   log("input frames: " + all.length);

   var todo = [];
   var already = 0;
   for (var i = 0; i < all.length; ++i) {
      if (File.exists(outputFor(all[i])))
         already++;
      else
         todo.push(all[i]);
   }
   log("already corrected: " + already + "   to do: " + todo.length);

   var done = already;
   var failed = 0;

   for (var start = 0; start < todo.length; start += BATCH_SIZE) {
      var batch = todo.slice(start, start + BATCH_SIZE);
      heartbeat("batch " + (start + 1) + "-" + (start + batch.length) + " of " + todo.length +
                " (" + done + "/" + all.length + " complete)");
      log("batch " + (start + 1) + "-" + (start + batch.length) + " of " + todo.length);

      var ok = false;
      try {
         ok = correctBatch(batch);
      } catch (e) {
         log("  EXCEPTION: " + e.message);
         ok = false;
      }
      if (!ok)
         log("  WARNING: CosmeticCorrection returned false for this batch");

      // Judge by output files, never by the process return value.
      for (var j = 0; j < batch.length; ++j) {
         if (File.exists(outputFor(batch[j])))
            done++;
         else {
            failed++;
            log("  MISSING OUTPUT: " + batch[j]);
         }
      }
   }

   log("");
   log("complete: " + done + "/" + all.length + " corrected, " + failed + " missing");
   heartbeat("done " + done + "/" + all.length);
}

try {
   main();
} catch (e) {
   log("FATAL: " + e.message);
   heartbeat("fatal");
}
