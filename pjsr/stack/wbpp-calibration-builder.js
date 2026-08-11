// wbpp-calibration-builder.js — WBPP pipeline builder for CALIBRATION-ONLY runs.
//
// Companion to wbpp-drizzle-builder.js, which is for the register/integrate
// pass over already-calibrated frames. This one runs at the other end of the
// chain: raw lights + a master bias + flats in, calibrated lights out.
//
// Two jobs:
//
//   1. Turn cosmetic correction OFF on every light group. CC is per-group state
//      with no CLI parameter, and automation mode inherits whatever the GUI was
//      last left on. The pipeline runs its own CosmeticCorrection afterwards
//      (pjsr/stack/cosmetic-correct.js, auto 3-sigma hot+cold); letting WBPP
//      also correct would apply two different corrections to the same frames.
//      WBPP's CC additionally REQUIRES a master dark, and this chain is
//      bias+flat only, so leaving it on would at best warn and at worst mangle.
//
//   2. Audit the group inventory. A calibration run is only correct if WBPP
//      actually saw a Bias group and a Flat group per filter; if a master flat
//      is missing, WBPP silently calibrates with bias only and the frames come
//      out with full vignetting. That failure is invisible until the stack is
//      built, so it is asserted here instead.
//
// Same eval contract as the drizzle builder: WBPP eval's this inside
// PipelineManager.runPipelineBuilder() with `engine` and `this` in scope, and a
// truthy return means WBPP skips its own light pipeline — so we must call
// this.buildPipelineForLight() ourselves. A THROW is swallowed into a warning
// and the default pipeline runs instead, which is why the marker file is
// written last and the caller verifies it.
//
// Modern JS is fine here: this runs inside WBPP's own scope.

{
   const auditPath = engine.outputDirectory + "/logs/calibration-builder-audit.txt";
   const alertPath = engine.outputDirectory + "/logs/calibration-builder-ALERT.txt";
   const lines = [];
   const alerts = [];

   const emit = function( s )
   {
      lines.push( s );
      console.noteln( "[cal-builder] " + s );
   };

   emit( "=== WBPP calibration builder: CC off + group audit ===" );

   // ---- inventory ---------------------------------------------------------
   const modes = [
      [ "PRE", BPP.GroupingMode.PRE ],
      [ "POST", BPP.GroupingMode.POST ]
   ];

   let biasGroups = 0;
   let darkGroups = 0;
   const flatFilters = {};
   const lightFilters = {};

   for ( let m = 0; m < modes.length; ++m )
   {
      const groups = engine.groupsManager.groupsForMode( modes[ m ][ 1 ] );
      emit( "--- " + modes[ m ][ 0 ] + " groups: " + groups.length + " ---" );
      for ( let i = 0; i < groups.length; ++i )
      {
         const g = groups[ i ];
         emit( "  imageType=" + g.imageType +
               "  filter=" + ( g.filter || "<none>" ) +
               "  exposure=" + g.exposureTime +
               "  binning=" + g.binning +
               "  frames=" + g.fileItems.length +
               "  [" + g.toString() + "]" );

         // Count once, from the PRE inventory: POST groups are the
         // post-calibration re-grouping of the same lights.
         if ( modes[ m ][ 0 ] != "PRE" )
            continue;
         if ( g.imageType == ImageType.Bias )
            biasGroups++;
         else if ( g.imageType == ImageType.Dark )
            darkGroups++;
         else if ( g.imageType == ImageType.Flat )
            flatFilters[ g.filter || "<none>" ] = ( flatFilters[ g.filter || "<none>" ] || 0 ) + g.fileItems.length;
         else if ( g.imageType == ImageType.Light )
            lightFilters[ g.filter || "<none>" ] = ( lightFilters[ g.filter || "<none>" ] || 0 ) + g.fileItems.length;
      }
   }

   // ---- assertions --------------------------------------------------------
   if ( biasGroups == 0 )
      alerts.push( "NO BIAS GROUP — lights would be calibrated with flat only" );

   const lightKeys = Object.keys( lightFilters );
   if ( lightKeys.length == 0 )
      alerts.push( "NO LIGHT FRAMES in this run" );

   for ( let i = 0; i < lightKeys.length; ++i )
   {
      const f = lightKeys[ i ];
      if ( !( f in flatFilters ) )
         alerts.push( "NO FLAT for filter '" + f + "' (" + lightFilters[ f ] +
                      " light frame(s)) — those frames would keep their vignetting" );
   }
   emit( "bias groups=" + biasGroups + "  dark groups=" + darkGroups );
   emit( "flats by filter: " + JSON.stringify( flatFilters ) );
   emit( "lights by filter: " + JSON.stringify( lightFilters ) );

   // ---- cosmetic correction off ------------------------------------------
   let ccOff = 0;
   for ( let m = 0; m < modes.length; ++m )
   {
      const groups = engine.groupsManager.groupsForMode( modes[ m ][ 1 ] );
      for ( let i = 0; i < groups.length; ++i )
      {
         const g = groups[ i ];
         if ( g.imageType != ImageType.Light )
            continue;
         g.enableCC( false );
         if ( g.ccData && g.ccData.enabled )
            alerts.push( "COSMETIC CORRECTION DID NOT TURN OFF for [" + g.toString() + "]" );
         else
            ccOff++;
      }
   }
   emit( "cosmetic correction disabled on " + ccOff + " light group(s)" );

   // ---- build the light pipeline ourselves --------------------------------
   this.buildPipelineForLight();
   emit( "buildPipelineForLight() done" );

   // ---- persist the audit; marker last ------------------------------------
   // buildExecutionPipeline() runs more than once and the first pass has no
   // POST groups yet, so both files are rewritten from scratch each pass --
   // including deleting a stale ALERT, or an early pass's alert outlives a
   // clean build and reads as a failure.
   try
   {
      if ( !File.directoryExists( engine.outputDirectory + "/logs" ) )
         File.createDirectory( engine.outputDirectory + "/logs", true );
      if ( File.exists( alertPath ) )
         File.remove( alertPath );
      if ( alerts.length > 0 )
      {
         File.writeTextFile( alertPath, alerts.join( "\n" ) + "\n" );
         emit( "ALERTS: " + alerts.length + " (see calibration-builder-ALERT.txt)" );
      }
      lines.push( "BUILDER-OK ccOff=" + ccOff + " biasGroups=" + biasGroups + " alerts=" + alerts.length );
      File.writeTextFile( auditPath, lines.join( "\n" ) + "\n" );
   }
   catch ( e )
   {
      console.criticalln( "[cal-builder] could not write audit: " + e.message );
      throw e;
   }
}
