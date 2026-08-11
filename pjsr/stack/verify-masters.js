// verify-masters.js — final acceptance check on the delivered masters.
//
// jsArguments: [mastersDir, reportPath]
//
// Reports, per master: geometry, astrometric solution present, background
// statistics, and a single-channel spike count as a hot-pixel proxy (a pixel
// far above BOTH horizontal neighbours). The CosmeticCorrection pre-pass should
// keep this low; the thin blue/halpha stacks are where it mattered most.
// ES5 only.

var mastersDir = jsArguments[0];
var reportPath = jsArguments[1];

var OUT = [];
function say(s) {
   console.writeln(s);
   OUT.push(s);
   try { File.writeTextFile(reportPath, OUT.join("\n") + "\n"); } catch (e) {}
}

function listMasters(dir) {
   var files = [], d = new FileFind();
   if (d.begin(dir + "/*.xisf")) {
      do { if (d.name != "." && d.name != "..") files.push(d.name); } while (d.next());
      d.end();
   }
   files.sort();
   return files;
}

// Count pixels that stand far above both horizontal neighbours, on a sampled
// grid. Not a true hot-pixel census — a relative indicator for comparing
// masters and runs.
function spikeRate(img, med, sigma) {
   var W = img.width, H = img.height;
   var checked = 0, spikes = 0;
   var thr = 8 * sigma;
   for (var y = Math.floor(H * 0.15); y < H * 0.85; y += 7) {
      for (var x = Math.floor(W * 0.15); x < W * 0.85; x += 7) {
         var v = img.sample(x, y, 0);
         var l = img.sample(x - 1, y, 0);
         var r = img.sample(x + 1, y, 0);
         checked++;
         if (v - l > thr && v - r > thr)
            spikes++;
      }
   }
   return { checked: checked, spikes: spikes,
            rate: (checked > 0) ? spikes / checked : 0 };
}

function main() {
   say("=== master verification ===");
   say("dir: " + mastersDir);
   say("");

   var files = listMasters(mastersDir);
   for (var i = 0; i < files.length; ++i) {
      var path = mastersDir + "/" + files[i];
      var ws, w;
      try {
         ws = ImageWindow.open(path);
         w = ws[0];
         for (var j = 1; j < ws.length; ++j) ws[j].forceClose();
      } catch (e) {
         say(files[i] + "  ERROR: " + e.message);
         continue;
      }

      var img = w.mainView.image;
      var med = img.median(), sigma = img.stdDev(), mad = img.MAD();
      var sp = spikeRate(img, med, sigma);

      say(files[i]);
      say("   geometry   : " + img.width + " x " + img.height +
          "   channels=" + img.numberOfChannels);
      say("   astrometry : hasAstrometricSolution=" + w.hasAstrometricSolution);
      say("   background : median=" + med.toFixed(6) +
          "  stdDev=" + sigma.toFixed(6) + "  MAD=" + mad.toFixed(6));
      say("   spikes     : " + sp.spikes + " / " + sp.checked +
          " sampled  (rate " + (sp.rate * 1e4).toFixed(2) + " per 10k)");
      say("");

      w.forceClose();
   }
   say("=== end ===");
}

try {
   main();
} catch (e) {
   say("FATAL: " + e.message);
}
