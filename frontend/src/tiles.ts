import type { Doc, ImageRegion, Tile, TileLayout } from "./types";

export const contributingTileColor = "#ffd166";

const styles = {
  train: { color: "#65deff", fill: "#65deff09", dash: [] as number[], width: 1.5, label: "Training" },
  val: { color: "#d8a3ff", fill: "#d8a3ff09", dash: [9, 4], width: 1.5, label: "Validation" },
  omitted: { color: "#a9b4c2", fill: "transparent", dash: [2, 5], width: 1, label: "Omitted" },
  unknown: { color: "#fff", fill: "transparent", dash: [4, 4], width: 1, label: "Unknown split" },
};

export function tileStyle(tile: Tile) {
  return tile.split === "train" || tile.split === "val" || tile.split === "omitted" ? styles[tile.split] : styles.unknown;
}

export function orderedTiles(tiles: Tile[], highlightedTileIds: string[]) {
  // Keep the faint complete grid underneath retained and selected windows.
  const highlighted = new Set(highlightedTileIds);
  const rank = (tile: Tile) => highlighted.has(tile.id) ? 2 : tile.split === "omitted" ? 0 : 1;
  return [...tiles].sort((a, b) => rank(a) - rank(b));
}

export function tileCounts(tiles: Tile[]) {
  const counts = { train: 0, val: 0, omitted: 0, unknown: 0 };
  for (const tile of tiles) {
    const group = tile.split === "train" || tile.split === "val" || tile.split === "omitted" ? tile.split : "unknown";
    counts[group] += 1;
  }
  return counts;
}

export function intersectingTiles(tiles: Tile[], region: ImageRegion) {
  return tiles.filter(tile => tile.x < region.x + region.width && tile.x + tile.width > region.x
    && tile.y < region.y + region.height && tile.y + tile.height > region.y);
}

export function layoutMatchesImage(layout: TileLayout, doc: Doc, corrected: boolean) {
  const space = corrected ? "canonical" : "original";
  const width = corrected ? doc.perspective?.width : doc.original_width;
  const height = corrected ? doc.perspective?.height : doc.original_height;
  return layout.coordinate_space === space && layout.width === width && layout.height === height
    && (space === "original" || JSON.stringify(layout.homography) === JSON.stringify(doc.perspective?.homography));
}
