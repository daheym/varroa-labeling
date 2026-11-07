import { intersectingTiles, orderedTiles, tileStyle, contributingTileColor } from "./tiles";
import type { ImageRegion, Tile } from "./types";

export default function TileCrop({ src, alt, region, tiles, highlightedTileIds, visible, className = "" }: {
  src: string; alt: string; region?: ImageRegion; tiles: Tile[];
  highlightedTileIds: string[]; visible: boolean; className?: string;
}) {
  const windows = visible && region ? orderedTiles(intersectingTiles(tiles, region), highlightedTileIds) : [];
  return <div className={`tile-crop ${className}`}>
    <img src={src} alt={alt} loading="lazy" width="96" height="96" />
    {visible && region && <svg className="tile-crop-overlay" aria-hidden="true"
      viewBox={`${region.x} ${region.y} ${region.width} ${region.height}`}>
      {windows.map(tile => {
        const highlighted = highlightedTileIds.includes(tile.id);
        const style = tileStyle(tile);
        return <g key={tile.id} data-usage={tile.split} data-contributing={highlighted}>
          <rect x={tile.x} y={tile.y} width={tile.width} height={tile.height}
            fill={style.fill} stroke="#14212d" strokeWidth={highlighted ? 7 : tile.split === "omitted" ? 2 : 4}
            strokeDasharray={tile.split === "omitted" ? style.dash.join(" ") : undefined}
            strokeOpacity={tile.split === "omitted" ? 0.35 : 1} vectorEffect="non-scaling-stroke" />
          {highlighted && <rect x={tile.x} y={tile.y} width={tile.width} height={tile.height}
            fill="none" stroke={contributingTileColor} strokeWidth="5" strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />}
          <rect x={tile.x} y={tile.y} width={tile.width} height={tile.height}
            fill="none" stroke={style.color} strokeOpacity={tile.split === "omitted" ? 0.65 : 1}
            strokeWidth={style.width} strokeDasharray={style.dash.join(" ") || undefined} vectorEffect="non-scaling-stroke" />
        </g>;
      })}
    </svg>}
  </div>;
}
