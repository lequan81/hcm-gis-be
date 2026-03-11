/**
 * MBTiles metadata specification types.
 * @see https://github.com/mapbox/mbtiles-spec/blob/master/1.3/spec.md
 */

/** Metadata fields for MBTiles file creation. */
export interface MBTilesMetadata {
  name: string;
  description?: string;
  format: "pbf" | "png" | "jpg" | "webp";
  type?: "overlay" | "baselayer";
  bounds?: string;
  center?: string;
  minzoom?: string;
  maxzoom?: string;
  json?: string;
}

/** Internal registry entry for an open MBTiles database. */
export interface RegistryEntry {
  db: import("bun:sqlite").Database;
  name: string;
  path: string;
}
