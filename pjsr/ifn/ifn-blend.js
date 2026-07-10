// ifn-blend.js — add the recovered IFN layer back into the final image.
// blended = final + k * ifn_display * exclusion
// The exclusion mask is built as a SEPARATE grayscale image first: using CIEL($T)
// inside the RGB blend expression collapses the target to luminance (all channels
// identical — bit us 2026-07-10). Gray mask context is safe; RGB blend stays scalar.
ImageWindow.swapDirectories = [ "D:/Temp/pixinsight-swap" ];
var FINAL = "Z:/M82/claude-processed/iteration_12.xisf";
var LAYER = "Z:/M82/claude-masters/ifn/ifn_layer.xisf";
var OUTX = "Z:/M82/claude-processed/iteration_12_ifn.xisf";
var SCRATCH = "D:/Temp/claude/D--projects-pixinsight-mcp/2d01b986-d27c-4484-b0b3-4f20f0d8eb87/scratchpad/";
var LOGFILE = SCRATCH + "ifn-blend.log";
var IFN_MAX_LIFT = 0.20;   // max lightness added in the brightest cirrus (Dan: plainly visible)
var EXCL_START = 0.15;     // final-image lightness where exclusion starts
var EXCL_FULL = 0.40;      // fully excluded at/above this lightness
var LOG=[]; function log(m){ console.writeln("[IFNb] "+m); LOG.push(m); try{File.writeTextFile(LOGFILE,LOG.join("\n")+"\n");}catch(e){} }

function main(){
   var fa=ImageWindow.open(FINAL); if(fa.length===0){ log("ERROR: no final "+FINAL); return; }
   var wf=fa[0]; wf.mainView.id="fin12";
   var la=ImageWindow.open(LAYER); if(la.length===0){ log("ERROR: no layer"); return; }
   var wl=la[0]; wl.mainView.id="ifnlay";
   var I=wf.mainView.image, L=wl.mainView.image;
   log("final "+I.width+"x"+I.height+"  layer "+L.width+"x"+L.height);
   if(I.width!=L.width||I.height!=L.height){ log("ERROR: size mismatch"); wf.forceClose(); wl.forceClose(); return; }

   // normalize layer over its cirrus range — SELECTIVE version (2026-07-10): floor
   // raised to med+2*MADN and gamma-2 applied so structured wisps carry the lift
   // while the broad faint haze contributes ~nothing (full-frame haze at 0.20 read
   // as washed-out overstretch — Dan).
   var med=L.median(), madn=L.MAD()*1.4826, mx=L.maximum();
   var lo=med+2*madn;
   var hi=Math.min(mx, med+12*madn);
   log("layer med="+med.toFixed(6)+" madn="+madn.toFixed(6)+" max="+mx.toFixed(4)+" lo="+lo.toFixed(5)+" hi="+hi.toFixed(5));
   var PM0=new PixelMath;
   PM0.expression="min(1, max(0, ($T - "+lo+") / ("+(hi-lo)+")))";
   PM0.useSingleExpression=true; PM0.createNewImage=false;
   PM0.rescale=false; PM0.truncate=true; PM0.truncateLower=0; PM0.truncateUpper=1;
   PM0.use64BitWorkingImage=true;
   PM0.executeOn(wl.mainView);
   // gamma 2 (PixelMath has no pow(): self-multiply), then SPATIAL galaxy exclusion:
   // value-based suppression of the galaxies' halos creates rings at halo contours
   // (tried, looked like moats). Instead zero the layer over the two galaxies with
   // feathered radial windows — IFN immediately around them is sacrificed.
   // M81 center ~(1392,2708), M82 center ~(3808,2528) in the 5128x5136 frame.
   var PMg=new PixelMath;
   PMg.expression="($T*$T)" +
      " * min(1, max(0, (sqrt((x()-1392)*(x()-1392)+(y()-2708)*(y()-2708)) - 800) / 250))" +
      " * min(1, max(0, (sqrt((x()-3808)*(x()-3808)+(y()-2528)*(y()-2528)) - 450) / 200))";
   PMg.useSingleExpression=true; PMg.createNewImage=false;
   PMg.rescale=false; PMg.truncate=true; PMg.truncateLower=0; PMg.truncateUpper=1;
   PMg.executeOn(wl.mainView);
   log("layer normalized (floor + gamma2 + spatial galaxy exclusion)");

   // exclusion mask as its own GRAY image (CIEL of the final is safe here)
   var mask=new ImageWindow(I.width,I.height,1,32,true,false,"exclmask");
   var PMm=new PixelMath;
   PMm.expression="1 - min(1, max(0, (CIEL(fin12) - "+EXCL_START+") / ("+(EXCL_FULL-EXCL_START)+")))";
   PMm.useSingleExpression=true; PMm.createNewImage=false;
   PMm.rescale=false; PMm.truncate=true; PMm.truncateLower=0; PMm.truncateUpper=1;
   PMm.executeOn(mask.mainView);
   log("exclusion mask built (gray)");

   // scalar RGB blend — no color-space functions in this expression
   var PM=new PixelMath;
   PM.expression = "$T + " + IFN_MAX_LIFT + " * ifnlay * exclmask";
   PM.useSingleExpression=true; PM.createNewImage=false;
   PM.rescale=false; PM.truncate=true; PM.truncateLower=0; PM.truncateUpper=1;
   PM.use64BitWorkingImage=true;
   PM.executeOn(wf.mainView);
   var img=wf.mainView.image;
   img.selectedChannel=0; var mr=img.median(); img.selectedChannel=1; var mg=img.median(); img.selectedChannel=2; var mb=img.median();
   img.resetSelections();
   log("blended: medians R/G/B = "+mr.toFixed(5)+"/"+mg.toFixed(5)+"/"+mb.toFixed(5)+" (must NOT be identical)");

   if(File.exists(OUTX)) File.remove(OUTX);
   wf.saveAs(OUTX,false,false,false,false);
   log("SAVED "+OUTX);
   wf.forceClose(); wl.forceClose(); mask.forceClose();
   log("IFN BLEND DONE");
}
try{ main(); }catch(e){ log("FATAL: "+e.message+(e.stack?("\n"+e.stack):"")); }
