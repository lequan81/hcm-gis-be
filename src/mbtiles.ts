/**
 * MBTiles Writer — stores raw MVT .pbf bytes into SQLite
 *
 * MBTiles spec: https://github.com/mapbox/mbtiles-spec/blob/master/1.3/spec.md
 * Uses Bun's built-in bun:sqlite for zero-dependency SQLite access.
 */

import { Database } from "bun:sqlite";

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

export class MBTilesWriter {
  private db: Database;
  private insertStmt: ReturnType<Database["prepare"]>;
  private tileCount = 0;

  constructor(filepath: string, metadata: MBTilesMetadata) {
    this.db = new Database(filepath, { create: true });

    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS metadata (
        name  TEXT NOT NULL,
        value TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tiles (
        zoom_level  INTEGER NOT NULL,
        tile_column INTEGER NOT NULL,
        tile_row    INTEGER NOT NULL,
        tile_data   BLOB NOT NULL
      )
    `);
    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS tile_index
        ON tiles (zoom_level, tile_column, tile_row)
    `);

    const metaStmt = this.db.prepare(
      "INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)"
    );
    for (const [k, v] of Object.entries(metadata)) {
      if (v !== undefined) metaStmt.run(k, String(v));
    }

    this.insertStmt = this.db.prepare(
      "INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)"
    );
  }

  writeTile(z: number, x: number, y: number, data: Uint8Array): void {
    const tmsY = (1 << z) - 1 - y;
    this.insertStmt.run(z, x, tmsY, data);
    this.tileCount++;
  }

  writeBatch(tiles: { z: number; x: number; y: number; data: Uint8Array }[]): void {
    this.db.run("BEGIN TRANSACTION");
    for (const t of tiles) {
      this.writeTile(t.z, t.x, t.y, t.data);
    }
    this.db.run("COMMIT");
  }

  get count(): number {
    return this.tileCount;
  }

  close(): void {
    this.db.run("PRAGMA journal_mode = DELETE");
    this.db.close();
  }
}
