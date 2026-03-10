import { basename } from "path";
import { Database } from "bun:sqlite";
import { log } from "./logger";

let nextId = 1;
const openDbs = new Map<string, { db: Database; name: string; path: string }>();

export function registerMBTiles(filePath: string): string {
  for (const [id, entry] of openDbs) {
    if (entry.path === filePath) return id;
  }
  const id = String(nextId++);
  const db = new Database(filePath, { readonly: true });
  openDbs.set(id, { db, name: basename(filePath), path: filePath });
  log("INFO", `Registered mbtiles #${id}: ${basename(filePath)}`);
  return id;
}

export function getMBTilesPath(id: string): string | null {
  const entry = openDbs.get(id);
  return entry ? entry.path : null;
}

export function getMBTilesName(id: string): string | null {
  const entry = openDbs.get(id);
  return entry ? entry.name : null;
}

export function unregisterMBTiles(id: string) {
  const entry = openDbs.get(id);
  if (entry) {
    entry.db.close();
    openDbs.delete(id);
  }
}

export function unregisterMBTilesByPath(filePath: string): boolean {
  for (const [id, entry] of openDbs) {
    if (entry.path === filePath) {
      try { entry.db.close(); } catch { }
      openDbs.delete(id);
      log("INFO", `Unregistered MBTiles by path: ${filePath}`);
      return true;
    }
  }
  return false;
}
