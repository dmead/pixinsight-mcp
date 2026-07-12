// ghs-ifn-finish.js — canonical M81/M82 IFN finishing chain (Dan-approved 2026-07-12).
// Input: pipeline deliverable (e.g. iteration_30_ifn.xisf, top-cropped 5126x5054).
// Steps:
//   1. NXT frequency-split BEFORE the big stretch (post-stretch NXT cannot fix the
//      re-amplified grain; run via a LICENSED instance — see pjsr-gotchas: XT license
//      is per-instance-slot, fresh -n slots silently return executeOn()=false).
//   2. Dan's GHS IFN reveal: SP = sky median, ln(D+1)=3.36, b=-1.8, LP=0, HP=0.89.
//   3. GHS Linear blackpoint re-anchor toward sky ~0.10 (skipped if already below).
//   4. Green-selective GOLD ROTATE for the inter-arm khaki (option C, Dan's pick):
//      X = 0.5*(G-B)*WL*WG; R+0.3X, G-0.7X, B+0.4X. Gates: L>0.25 (ramp .10) AND
//      G-B>0 (ramp 30m) — blue knots, lavender core, sky untouched; luminance kept.
ImageWindow.swapDirectories = [ "D:/Temp/pixinsight-swap" ];
var SRC = "Z:/M82/claude-processed/iteration_30_ifn.xisf";
var OUT = "Z:/M82/claude-processed/iteration_30_ghs_final.xisf";
var LOGFILE = "D:/Temp/pixinsight-swap/ghs-ifn-finish.log";
var LOG=[]; function log(m){ console.writeln("[GIF] "+m); LOG.push(m); try{File.writeTextFile(LOGFILE,LOG.join("\n")+"\n");}catch(e){} }

var a=ImageWindow.open(SRC);
if(a.length===0){ log("ERROR open "+SRC); } else {
   var w=a[0];

   // 1. denoise (verify effect — silent license no-op returns false)
   var N=new NoiseXTerminator;
   N.ai_file='NoiseXTerminator.3.pb';
   N.enable_frequency_separation=true; N.frequency_scale=8;
   N.denoise=0.60; N.denoise_lf=0.35; N.denoise_color=0.85; N.denoise_lf_color=0.50;
   N.detail=0.15;
   var okN=N.executeOn(w.mainView);
   log("NXT executeOn="+okN+(okN?"":"  *** UNLICENSED SLOT — run via watcher! ***"));

   // 2. GHS IFN reveal
   var med=w.mainView.image.median();
   var G=new GeneralizedHyperbolicStretch;
   G.stretchType=GeneralizedHyperbolicStretch.prototype.ST_GeneralisedHyperbolic;
   G.stretchFactor=3.360; G.localIntensity=-1.800;
   G.symmetryPoint=med; G.shadowProtection=0.0; G.highlightProtection=0.890;
   G.stretchChannel=GeneralizedHyperbolicStretch.prototype.SC_RGB;
   G.clipType=GeneralizedHyperbolicStretch.prototype.CT_RGBBlend;
   G.executeOn(w.mainView);
   log("GHS done (SP="+med.toFixed(5)+")");

   // 3. linear BP re-anchor (only if sky drifted above target)
   function darkTileMedian(img,T){
      var best=1;
      for (var y=0;y<img.height;y+=T)
         for (var x=0;x<img.width;x+=T){
            img.selectedRect=new Rect(x,y,Math.min(x+T,img.width),Math.min(y+T,img.height));
            var m=img.median(); if(m<best) best=m;
         }
      img.resetSelections(); return best;
   }
   var sky=darkTileMedian(w.mainView.image,256);
   var target=0.10;
   if (sky>target){
      var bp=(sky-target)/(1-target);
      var LN=new GeneralizedHyperbolicStretch;
      LN.stretchType=GeneralizedHyperbolicStretch.prototype.ST_Linear;
      LN.blackPoint=bp; LN.whitePoint=1.0;
      LN.stretchChannel=GeneralizedHyperbolicStretch.prototype.SC_RGB;
      LN.clipType=GeneralizedHyperbolicStretch.prototype.CT_RGBBlend;
      LN.executeOn(w.mainView);
      log("linear BP="+bp.toFixed(5));
   } else log("BP skip (sky "+sky.toFixed(4)+" <= "+target+")");

   // 4. gold rotate (option C)
   var LM="(($T[0]+$T[1]+$T[2])/3)";
   var WL="min(1,max(0,("+LM+" - 0.25)/0.10))";
   var WG="min(1,max(0,($T[1]-$T[2])/0.03))";
   var X="(0.5*($T[1]-$T[2])*"+WL+"*"+WG+")";
   var PM=new PixelMath;
   PM.useSingleExpression=false;
   PM.expression="$T + 0.3*"+X; PM.expression1="$T - 0.7*"+X; PM.expression2="$T + 0.4*"+X;
   PM.createNewImage=false; PM.use64BitWorkingImage=true;
   PM.truncate=true; PM.truncateLower=0; PM.truncateUpper=1;
   PM.executeOn(w.mainView);
   log("gold rotate applied");

   if(File.exists(OUT)) File.remove(OUT);
   w.saveAs(OUT,false,false,false,false);
   log("SAVED "+OUT);
   w.forceClose();
}
log("GHS IFN FINISH DONE");
