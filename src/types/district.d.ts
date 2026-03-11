/**
 * District and tile geometry types.
 */

/** A single HCM City district definition. */
export interface District {
  name: string;
  bbox: [number, number, number, number]; // [lon_min, lat_min, lon_max, lat_max]
}

/** Tile coordinate range for a bounding box at a given zoom level. */
export interface TileRange {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  count: number;
}
