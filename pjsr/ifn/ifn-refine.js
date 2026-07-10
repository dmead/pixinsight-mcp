// ifn-refine.js — turn the raw IFN detection into a clean blendable layer.
// From ifn_linear.xisf: heavy smoothing at IFN scales (sigma 8 ~ arcmin structures),
// floor at the darkest tile, edge feather (corner falloff isn't IFN), save layer + view.
ImageWindow.swapDirectories = [ "D:/Temp/pixinsight-swap" ];
var OUTDIR = "Z:/M82/claude-masters/ifn/";
var SCRATCH = "D:/Temp/claude/D--projects-pixinsight-mcp/2d01b986-d27c-4484-b0b3-4f20f0d8eb87/scratchpad/";
var LOGFILE = SCRATCH + "ifn-refine.log";
var LOG=[]; function log(m){ console.writeln("[IFNr] "+m); LOG.push(m); try{File.writeTextFile(LOGFILE,LOG.join("\n")+"\n");}catch(e){} }

function darkestTileMedian(img,T){
   var best=1;
   for(var y=0;y<img.height;y+=T)
      for(var x=0;x<img.width;x+=T){
         img.selectedRect=new Rect(x,y,Math.min(x+T,img.width),Math.min(y+T,img.height));
         var m=img.median(); if(m<best)best=m;
      }
   img.resetSelections(); return best;
}

function main(){
   var arr=ImageWindow.open(OUTDIR+"ifn_linear.xisf");
   if(arr.length===0){ log("ERROR: no ifn_linear"); return; }
   var w=arr[0]; w.mainView.id="ifn_l";
   var W0=w.mainView.image.width, H0=w.mainView.image.height;

   // strong smoothing at IFN scale (already sigma-3'd once)
   var CV=new Convolution; CV.mode=Convolution.prototype.Parametric;
   CV.sigma=8.0; CV.shape=2.0; CV.aspectRatio=1.0;
   CV.executeOn(w.mainView);
   log("smoothed sigma 8");

   // floor at darkest tile, rescale positives
   var floor=darkestTileMedian(w.mainView.image,256);
   var PM=new PixelMath;
   PM.expression="max(0, $T - "+floor+")";
   PM.useSingleExpression=true; PM.createNewImage=false;
   PM.rescale=false; PM.truncate=true; PM.truncateLower=0; PM.truncateUpper=1;
   PM.use64BitWorkingImage=true;
   PM.executeOn(w.mainView);
   log("floored at "+floor.toFixed(6)+"; post median="+w.mainView.image.median().toFixed(6));

   // edge feather: corners carry residual vignetting, not IFN — roll the layer off
   // toward the borders (10% feather) with a radial-ish window built from x/y ramps
   var PM2=new PixelMath;
   PM2.expression="$T * min(1, min(x(), "+(W0-1)+"-x())/(0.10*"+W0+")) * min(1, min(y(), "+(H0-1)+"-y())/(0.10*"+H0+"))";
   PM2.useSingleExpression=true; PM2.createNewImage=false;
   PM2.rescale=false; PM2.truncate=true; PM2.truncateLower=0; PM2.truncateUpper=1;
   PM2.executeOn(w.mainView);
   log("edges feathered (10%)");

   w.saveAs(OUTDIR+"ifn_layer.xisf",false,false,false,false);
   log("saved "+OUTDIR+"ifn_layer.xisf");

   // inspection view: hard stretch + downsample
   if (typeof GeneralizedHyperbolicStretch !== 'undefined') {
      var G1=new GeneralizedHyperbolicStretch;
      G1.stretchType=GeneralizedHyperbolicStretch.prototype.ST_GeneralisedHyperbolic;
      G1.stretchChannel=GeneralizedHyperbolicStretch.prototype.SC_RGB;
      G1.stretchFactor=9.0; G1.localIntensity=2.5;
      G1.symmetryPoint=Math.max(0.00001,w.mainView.image.median());
      G1.shadowProtection=0.0; G1.highlightProtection=0.9;
      G1.clipType=GeneralizedHyperbolicStretch.prototype.CT_RGBBlend;
      G1.executeOn(w.mainView);
   }
   var IR=new IntegerResample; IR.zoomFactor=-4; IR.downsamplingMode=IntegerResample.prototype.Average;
   IR.executeOn(w.mainView);
   w.setSampleFormat(16,false);
   w.saveAs(SCRATCH+"ifn_layer_view.png",false,false,false,false);
   log("view saved ifn_layer_view.png");
   w.forceClose();
   log("IFN REFINE DONE");
}
try{ main(); }catch(e){ log("FATAL: "+e.message+(e.stack?("\n"+e.stack):"")); }
