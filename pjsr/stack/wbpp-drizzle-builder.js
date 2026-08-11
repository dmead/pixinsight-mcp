// wbpp-drizzle-builder.js — WBPP pipeline builder script.
//
// Enables regular (non-fast) 2x drizzle on every light group, and audits the
// group inventory, before delegating to WBPP's own light pipeline builder.
//
// Drizzle is per-group state with no CLI parameter, so this is the only way to
// turn it on in automation mode. WBPP eval's this file inside
// PipelineManager.runPipelineBuilder() with `engine` and `this` (the
// PipelineManager) in scope; if it returns truthy WBPP does NOT build the
// default light pipeline, so we must call this.buildPipelineForLight()
// ourselves. If it THROWS, WBPP logs a warning and silently falls back to the
// default (no drizzle) pipeline — which is why the marker file below is
// written last and the caller must verify it.
//
// Modern JS is fine here: this runs inside WBPP's own scope, not a plain
// ES5 PJSR script.

{
   const DRIZZLE_SCALE = 2;
   const DRIZZLE_DROP_SHRINK = 0.9;   // baseline; optimized per filter afterwards
   const DRIZZLE_GRID_SIZE = 16;

   const auditPath = engine.outputDirectory + "/logs/pipeline-builder-audit.txt";
   const alertPath = engine.outputDirectory + "/logs/pipeline-builder-ALERT.txt";
   const lines = [];
   const alerts = [];

   const emit = function( s )
   {
      lines.push( s );
      console.noteln( "[builder] " + s );
   };

   emit( "=== WBPP pipeline builder: drizzle " + DRIZZLE_SCALE + "x + group audit ===" );

   // ---- group audit -------------------------------------------------------
   // Inputs are already-calibrated lights, so a non-Light group means a stale
   // persisted master (bias/dark/flat) leaked into the run. Automation mode
   // inherits GUI settings; only the file LISTS are CLI-only. This is the
   // positive in-run proof that calibration did not happen.
   const modes = [
      [ "PRE", BPP.GroupingMode.PRE ],
      [ "POST", BPP.GroupingMode.POST ]
   ];

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
               "  CFA=" + g.isCFA +
               "  frames=" + g.fileItems.length +
               "  [" + g.toString() + "]" );
         if ( g.imageType != ImageType.Light )
            alerts.push( "NON-LIGHT GROUP in " + modes[ m ][ 0 ] + ": imageType=" + g.imageType +
                         " frames=" + g.fileItems.length + " [" + g.toString() + "]" );
      }
   }

   // ---- enable drizzle on every post-calibration light group --------------
   const groupsPOST = engine.groupsManager.groupsForMode( BPP.GroupingMode.POST );
   let enabled = 0;
   let unavailable = 0;

   for ( let i = 0; i < groupsPOST.length; ++i )
   {
      const g = groupsPOST[ i ];
      if ( g.imageType != ImageType.Light )
         continue;

      if ( !g.isDrizzleAvailable() )
      {
         unavailable++;
         alerts.push( "DRIZZLE UNAVAILABLE for group [" + g.toString() + "]" );
         continue;
      }

      g.enableDrizzle();
      g.setDrizzleScale( DRIZZLE_SCALE );          // WBPP's default is 1
      g.setDrizzleDropShrink( DRIZZLE_DROP_SHRINK );
      g.setDrizzleFast( false );                   // regular drizzle, never fast
      // NOT DrizzleIntegration.Kernel_Square — the static form is undefined
      // (probed 2026-08-07). Only the prototype carries the enum. WBPP's own
      // BPP.Defaults.drizzleFunction uses the static form and is therefore
      // undefined, so setting this explicitly matters.
      g.setDrizzleFunction( DrizzleIntegration.prototype.Kernel_Square );
      g.setDrizzleGridSize( DRIZZLE_GRID_SIZE );

      if ( g.isDrizzleEnabled() )
      {
         enabled++;
         emit( "  drizzle ON  scale=" + DRIZZLE_SCALE +
               " dropShrink=" + DRIZZLE_DROP_SHRINK +
               " fast=false  [" + g.toString() + "]" );
      }
      else
         alerts.push( "DRIZZLE DID NOT STICK for group [" + g.toString() + "]" );
   }

   emit( "drizzle enabled on " + enabled + " light group(s); " + unavailable + " unavailable" );
   if ( enabled == 0 )
      alerts.push( "NO LIGHT GROUP GOT DRIZZLE — the run would produce 1x masters only" );

   // ---- build the light pipeline ourselves --------------------------------
   this.buildPipelineForLight();
   emit( "buildPipelineForLight() done" );

   // ---- persist the audit; the marker is written LAST ---------------------
   // WBPP calls buildExecutionPipeline() more than once. On the FIRST call the
   // POST groups do not exist yet, so that pass legitimately sees zero drizzle
   // groups; only the last build is the one that executes. Both files are
   // therefore rewritten from scratch every pass — including DELETING a stale
   // ALERT — or the early pass's alert outlives the good build and reads as a
   // failure. (Observed 2026-08-07: ALERT 1.3 s older than a clean audit.)
   try
   {
      if ( !File.directoryExists( engine.outputDirectory + "/logs" ) )
         File.createDirectory( engine.outputDirectory + "/logs", true );
      if ( File.exists( alertPath ) )
         File.remove( alertPath );
      if ( alerts.length > 0 )
      {
         File.writeTextFile( alertPath, alerts.join( "\n" ) + "\n" );
         emit( "ALERTS: " + alerts.length + " (see pipeline-builder-ALERT.txt)" );
      }
      lines.push( "BUILDER-OK drizzleGroups=" + enabled + " alerts=" + alerts.length );
      File.writeTextFile( auditPath, lines.join( "\n" ) + "\n" );
   }
   catch ( e )
   {
      console.criticalln( "[builder] could not write audit: " + e.message );
      throw e;
   }
}
