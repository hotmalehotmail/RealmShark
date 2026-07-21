import DpsSparkline from '../DpsSparkline'

/**
 * Standalone DPS trend graph (issue #259): the sparkline that used to live
 * embedded in `DpsPanel` (and was dropped entirely at `sm`) is now its own
 * placeable/sizable panel, so a player can position the graph wherever they
 * want - or close it - without giving up the numeric DPS readout.
 * `DpsSparkline` owns all of the graph's presentation (PRD §4's binding
 * layering contract, docs/prd-dps-graph.md); this body just gives it the
 * full panel area at every preset size.
 */
function DpsGraphPanel(): React.JSX.Element {
  return (
    <div className="h-full w-full">
      <DpsSparkline />
    </div>
  )
}

export default DpsGraphPanel
