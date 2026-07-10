// ifn-probe.js — first look for Integrated Flux Nebula in the M81/M82 field.
// Sum L+R+G+B (linear, patched masters) for max SNR on faint common signal, remove
// stars (full SXT), subtract ONLY a planar (degree-1) background so structured cirrus
// survives, smooth, hard-stretch, export full-frame view.
ImageWindow.swapDirectories = [ "D:/Temp/pixinsight-swap" ];
var W = "Z:/M82/claude-masters/working/";
var OUTDIR = "Z:/M82/claude-masters/ifn/";
var SCRATCH = "D:/Temp/claude/D--projects-pixinsight-mcp/2d01b986-d27c-4484-b0b3-4f20f0d8eb87/scratchpad/";
var LOGFILE = SCRATCH + "ifn-probe.log";
var LOG=[]; function log(m){ console.writeln("[IFN] "+m); LOG.push(m); try{File.writeTextFile(LOGFILE,LOG.join("\n")+"\n");}catch(e){} }

function main(){
   if(!File.directoryExists(OUTDIR.replace(/\/+$/,""))) File.createDirectory(OUTDIR.replace(/\/+$/,""),true);
   var wl=ImageWindow.open(W+"M82_L.xisf")[0]; wl.mainView.id="c_L";
   var wr=ImageWindow.open(W+"M82_R.xisf")[0]; wr.mainView.id="c_R";
   var wg=ImageWindow.open(W+"M82_G.xisf")[0]; wg.mainView.id="c_G";
   var wb=ImageWindow.open(W+"M82_B.xisf")[0]; wb.mainView.id="c_B";
   var W0=wl.mainView.image.width, H0=wl.mainView.image.height;

   var combo=new ImageWindow(W0,H0,1,32,true,false,"ifn_combo");
   var PM=new PixelMath;
   PM.expression="c_L + c_R + c_G + c_B";
   PM.useSingleExpression=true; PM.createNewImage=false;
   PM.rescale=false; PM.truncate=true; PM.truncateLower=0; PM.truncateUpper=1;
   PM.use64BitWorkingImage=true;
   PM.executeOn(combo.mainView);
   wl.forceClose(); wr.forceClose(); wg.forceClose(); wb.forceClose();
   log("combo built: median="+combo.mainView.image.median().toFixed(5));

   // star removal — full model
   var SX=new StarXTerminator; SX.ai_file='StarXTerminator.11.pb';
   SX.stars=false; SX.overlap=0.20;
   SX.executeOn(combo.mainView);
   log("stars removed");

   // planar background only: ABE degree 1, subtract
   var ABE=new AutomaticBackgroundExtractor;
   ABE.polyDegree=1;
   ABE.abeDownsample=2.0;
   ABE.writeSampleBoxes=false;
   ABE.justTrySamples=false;
   ABE.targetCorrection=AutomaticBackgroundExtractor.prototype.Correction_Subtract;
   ABE.normalize=true;
   ABE.discardModel=true;
   ABE.replaceTarget=true;
   ABE.correctedImageId="";
   ABE.correctedImageSampleFormat=AutomaticBackgroundExtractor.prototype.CorrectedFormat_SameAsTarget;
   ABE.executeOn(combo.mainView);
   log("planar (deg1) background subtracted: median="+combo.mainView.image.median().toFixed(6));

   // gentle large-scale smoothing: sigma 3 gaussian (IFN is arcmin-scale; noise is px-scale)
   var CV=new Convolution; CV.mode=Convolution.prototype.Parametric;
   CV.sigma=3.0; CV.shape=2.0; CV.aspectRatio=1.0;
   CV.executeOn(combo.mainView);
   log("smoothed sigma 3");

   combo.saveAs(OUTDIR+"ifn_linear.xisf",false,false,false,false);
   log("saved linear IFN base: "+OUTDIR+"ifn_linear.xisf");

   // hard display stretch for inspection: clip at darkest-tile, GHS big lift
   var med=combo.mainView.image.median(), madn=combo.mainView.image.MAD()*1.4826;
   if (typeof GeneralizedHyperbolicStretch !== 'undefined') {
      var L1=new GeneralizedHyperbolicStretch;
      L1.stretchType=GeneralizedHyperbolicStretch.prototype.ST_Linear;
      L1.stretchChannel=GeneralizedHyperbolicStretch.prototype.SC_RGB;
      L1.blackPoint=Math.max(0,med-2*madn); L1.whitePoint=1.0;
      L1.clipType=GeneralizedHyperbolicStretch.prototype.CT_RGBBlend;
      L1.executeOn(combo.mainView);
      var G1=new GeneralizedHyperbolicStretch;
      G1.stretchType=GeneralizedHyperbolicStretch.prototype.ST_GeneralisedHyperbolic;
      G1.stretchChannel=GeneralizedHyperbolicStretch.prototype.SC_RGB;
      G1.stretchFactor=8.0; G1.localIntensity=2.0;
      G1.symmetryPoint=Math.max(0.00001, combo.mainView.image.median());
      G1.shadowProtection=0.0; G1.highlightProtection=0.9;
      G1.clipType=GeneralizedHyperbolicStretch.prototype.CT_RGBBlend;
      G1.executeOn(combo.mainView);
      log("display stretch applied (GHS D=8 b=2)");
   }
   combo.saveAs(OUTDIR+"ifn_stretched.xisf",false,false,false,false);

   // downsampled full-frame PNG for automated inspection
   var IR=new IntegerResample; IR.zoomFactor=-4; IR.downsamplingMode=IntegerResample.prototype.Average;
   IR.executeOn(combo.mainView);
   combo.setSampleFormat(16,false);
   combo.saveAs(SCRATCH+"ifn_probe_view.png",false,false,false,false);
   log("view saved: ifn_probe_view.png ("+combo.mainView.image.width+"x"+combo.mainView.image.height+")");
   combo.forceClose();
   log("IFN PROBE DONE");
}
try{ main(); }catch(e){ log("FATAL: "+e.message+(e.stack?("\n"+e.stack):"")); }
