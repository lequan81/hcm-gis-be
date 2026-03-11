import { basename, join } from "path";
import { Database } from "bun:sqlite";
import { readdirSync, existsSync } from "fs";
import { log } from "../utils/logger";
import { env } from "../config";
import type { RegistryEntry } from "../types/mbtiles";

const openDbs = new Map<string, RegistryEntry>();

/** 
 * Register an mbtiles file. 
 * Expected filename format: hcm_district_date_time_uuid.mbtiles 
 */
export function registerMBTiles(filePath: string): string {
  const name = basename(filePath);
  
  // Extract UUID from name as stable ID. Fallback to random if not found.
  let id: string;
  const match = name.match(/_([a-f0-9\-]{36})\.mbtiles$/i);
  if (match) {
    id = match[1];
  } else {
    log("WARN", `MBTiles filename missing UUID: ${name}. Generating random ID.`);
    id = crypto.randomUUID();
  }

  const existing = openDbs.get(id);
  if (existing) {
    if (existing.path === filePath) return id;
    try { existing.db.close(); } catch { }
  }

  try {
    const db = new Database(filePath, { readonly: true });
    openDbs.set(id, { db, name, path: filePath });
    log("INFO", `Registered mbtiles #${id}: ${name}`);
    return id;
  } catch (err: any) {
    log("ERROR", `Failed to open mbtiles DB ${filePath}: ${err.message}`);
    return id; // Return ID anyway to prevent full crash, though downloading will fail
  }
}

/** Get the file path for a given ID, with disk-scan fallback */
export function getMBTilesPath(id: string): string | null {
  const entry = openDbs.get(id);
  if (entry) return entry.path;
  return scanAndRegister(id);
}

/** Get the filename for a given ID */
export function getMBTilesName(id: string): string | null {
  if (!openDbs.has(id)) scanAndRegister(id);
  const entry = openDbs.get(id);
  return entry ? entry.name : null;
}

/** Scan OUTPUT_DIR for a file whose UUID matches the given ID. */
function scanAndRegister(id: string): string | null {
  try {
    const dir = env.OUTPUT_DIR;
    if (!existsSync(dir)) return null;

    const files = readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith(".mbtiles")) continue;
      if (f.includes(id)) {
        const fullPath = join(dir, f);
        registerMBTiles(fullPath);
        log("INFO", `Disk-scan found mbtiles #${id}: ${f}`);
        return fullPath;
      }
    }
  } catch (err: any) {
    log("ERROR", `Disk-scan failed: ${err?.message}`);
  }
  return null;
}

/** Scan OUTPUT_DIR on startup and register all existing .mbtiles files */
export function scanOutputDirectory(): number {
  try {
    const dir = env.OUTPUT_DIR;
    if (!existsSync(dir)) return 0;

    const files = readdirSync(dir).filter(f => f.endsWith(".mbtiles"));
    let count = 0;
    for (const f of files) {
      registerMBTiles(join(dir, f));
      count++;
    }
    if (count > 0) {
      log("INFO", `Startup scan: registered ${count} existing mbtiles file(s)`);
    }
    return count;
  } catch (err: any) {
    log("ERROR", `Startup scan failed: ${err?.message}`);
    return 0;
  }
}

/**
 * Handle Release Watcher:
 * Automatically unregister DBs if their files have been deleted 
 * by the bash cleanup script. This prevents SQLite from holding onto disk space.
 */
export function startRegistryCleanupWatcher() {
  // Check every hour (3600000 ms)
  setInterval(() => {
    let closed = 0;
    for (const [id, entry] of openDbs.entries()) {
      if (!existsSync(entry.path)) {
        try { entry.db.close(); } catch { }
        openDbs.delete(id);
        closed++;
        log("INFO", `Watcher: Released orphaned DB handle for #${id}`);
      }
    }
    if (closed > 0) {
      log("INFO", `Watcher: Cleaned up ${closed} deleted MBTiles from memory.`);
    }
  }, 3600000);
}
