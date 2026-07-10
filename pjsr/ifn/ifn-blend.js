// ifn-blend.js — add the recovered IFN layer back into the final image.
// blended = final + k * ifn_display * exclusion, where:
//   ifn_display = gently stretched linear IFN layer, normalized so its brightest
//                 cirrus contributes ~IFN_MAX_LIFT of lightness
//   exclusion   = rolls off where the FINAL image is already bright (galaxies,
//                 star cores) so nothing already-rendered gets double-lit
// Neutral (gray) contribution — house style; chroma stays untouched.
ImageWindow.swapDirectories = [ "D:/Temp/pixinsight-swap" ];
var FINAL = "Z:/M82/claude-processed/iteration_12.xisf";
var LAYER = "Z:/M82/claude-masters/ifn/ifn_layer.xisf";
var OUTX = "Z:/M82/claude-processed/iteration_12_ifn.xisf";
var SCRATCH = "D:/Temp/claude/D--projects-pixinsight-mcp/2d01b986-d27c-4484-b0b3-4f20f0d8eb87/scratchpad/";
var LOGFILE = SCRATCH + "ifn-blend.log";
var IFN_MAX_LIFT = 0.10;   // max lightness added in the brightest cirrus
var EXCL_START = 0.15;     // final-image brightness where exclusion starts
var EXCL_FULL = 0.40;      // fully excluded at/above this brightness
var LOG=[]; function log(m){ console.writeln("[IFNb] "+m); LOG.push(m); try{File.writeTextFile(LOGFILE,LOG.join("\n")+"\n");}catch(e){} }

function main(){
   var fa=ImageWindow.open(FINAL); if(fa.length===0){ log("ERROR: no final "+FINAL); return; }
   var wf=fa[0]; wf.mainView.id="fin12";
   var la=ImageWindow.open(LAYER); if(la.length===0){ log("ERROR: no layer"); return; }
   var wl=la[0]; wl.mainView.id="ifnlay";
   var I=wf.mainView.image, L=wl.mainView.image;
   log("final "+I.width+"x"+I.height+"  layer "+L.width+"x"+L.height);
   if(I.width!=L.width||I.height!=L.height){ log("ERROR: size mismatch"); wf.forceClose(); wl.forceClose(); return; }

   // normalize layer: p99.9-ish via max after smoothing is fine — use 0.999 quantile
   // approximation: stretch so that (median + 6*MADN .. max) maps sensibly. Simpler:
   // scale so the 99.9th percentile ~= 1.0 using iterative max clip.
   var med=L.median(), madn=L.MAD()*1.4826, mx=L.maximum();
   var hi=Math.min(mx, med+12*madn);   // robust bright-cirrus level (galaxies clipped later by exclusion anyway)
   log("layer med="+med.toFixed(6)+" madn="+madn.toFixed(6)+" max="+mx.toFixed(4)+" hi="+hi.toFixed(5));
   var PM0=new PixelMath;
   PM0.expression="min(1, max(0, ($T - "+med+") / ("+(hi-med)+")))";
   PM0.useSingleExpression=true; PM0.createNewImage=false;
   PM0.rescale=false; PM0.truncate=true; PM0.truncateLower=0; PM0.truncateUpper=1;
   PM0.use64BitWorkingImage=true;
   PM0.executeOn(wl.mainView);
   log("layer normalized (0..1 over cirrus range)");

   // blend with brightness exclusion computed from the final's own luminance
   var PM=new PixelMath;
   PM.expression = "$T + " + IFN_MAX_LIFT + " * ifnlay * " +
      "(1 - min(1, max(0, (CIEL($T) - " + EXCL_START + ") / (" + (EXCL_FULL-EXCL_START) + "))))";
   PM.useSingleExpression=true; PM.createNewImage=false;
   PM.rescale=false; PM.truncate=true; PM.truncateLower=0; PM.truncateUpper=1;
   PM.use64BitWorkingImage=true;
   PM.executeOn(wf.mainView);
   log("blended: lift="+IFN_MAX_LIFT+" exclusion "+EXCL_START+".."+EXCL_FULL+"; new median="+wf.mainView.image.median().toFixed(5));

   wf.saveAs(OUTX,false,false,false,false);
   log("SAVED "+OUTX);
   wf.forceClose(); wl.forceClose();
   log("IFN BLEND DONE");
}
try{ main(); }catch(e){ log("FATAL: "+e.message+(e.stack?("\n"+e.stack):"")); }
