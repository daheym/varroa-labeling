import type { Tile } from "./types";
import { tileCounts } from "./tiles";

export default function TileLegend({ tiles, completeGrid }: { tiles?: Tile[]; completeGrid?: boolean }) {
  const counts = tiles ? tileCounts(tiles) : null;
  return <div className="tile-overlay-help">
    <div className="tile-legend" aria-label="Tile usage legend">
      <span><i className="tile-key tile-key-train" aria-hidden="true" />Training{counts ? ` (${counts.train})` : ""}</span>
      <span><i className="tile-key tile-key-val" aria-hidden="true" />Validation{counts ? ` (${counts.val})` : ""}</span>
      <span><i className="tile-key tile-key-omitted" aria-hidden="true" />Omitted from run{counts ? ` (${counts.omitted})` : ""}</span>
      {counts && counts.unknown > 0 && <span>Unknown split ({counts.unknown})</span>}
      <span><i className="tile-key tile-key-selected" aria-hidden="true" />Gold halo: selected crop's outcome tiles</span>
    </div>
    {completeGrid === false && <div>Only saved tiles are available; complete grid metadata is missing for this run.</div>}
  </div>;
}
