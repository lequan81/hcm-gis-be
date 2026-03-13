/**
 * HCMC 3D Building Tiles — API Server
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { env } from "./config";
import { log } from "./utils/logger";
import { corsHeaders, json } from "./utils/response";
import { scanOutputDirectory, startRegistryCleanupWatcher } from "./services/mbtiles-registry.service";
import { terminateAllWorkers } from "./services/download-orchestrator.service";
import { DistrictsController } from "./controllers/districts.controller";
import { DownloadController } from "./controllers/download.controller";
import { RateLimiter } from "./utils/rate-limiter";
import { initRedis, closeRedis } from "./utils/redis";

const rateLimiter = new RateLimiter(60000, 45);

// ── Bootstrap ────────────────────────────────────────────────

for (const d of [env.OUTPUT_DIR, env.LOG_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// 1. Pre-register existing mbtiles files on startup
const scanned = scanOutputDirectory();

// 2. Start the registry watcher to close handles of deleted files
startRegistryCleanupWatcher();

// 3. Initialize Redis (non-blocking, graceful fallback)
await initRedis();

// 4. Start file retention cleanup (runs every hour)
startRetentionCleanup();

// ── Server ───────────────────────────────────────────────────

Bun.serve({
  port: env.PORT,
  idleTimeout: 255, // Max value (seconds) — prevents SSE streams from being killed
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = req.headers.get("origin");

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── API: districts (cacheable static data) ──
    if (path === "/api/districts") {
      return DistrictsController.getDistricts(req);
    }

    // ── API: check/download bundle (zip) ──
    if (path === "/api/bundle" && req.method === "GET") {
      return DownloadController.downloadBundle(req, url);
    }

    // ── API: cancel jobs ──
    if (path === "/api/cancel" && req.method === "POST") {
      return DownloadController.cancelJobs(req, url);
    }

    const ip = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown";

    // ── API: SSE download all ── (async rate limiter)
    if (path === "/api/download-all" && req.method === "GET") {
      if (await rateLimiter.isRateLimited(ip)) return json({ error: "Too many requests" }, 429, origin);
      return DownloadController.streamDownloadAll(req, url);
    }

    // ── API: SSE download specific districts ──
    if (path === "/api/download" && req.method === "GET") {
      if (await rateLimiter.isRateLimited(ip)) return json({ error: "Too many requests" }, 429, origin);
      return DownloadController.streamDownload(req, url);
    }

    // ── API: file endpoints (UUID matched) ──
    const fileMatch = path.match(/^\/api\/files\/([a-f0-9\-]{36})$/i);
    if (fileMatch) {
      return DownloadController.downloadFile(req, fileMatch[1]);
    }
    
    const gjMatch = path.match(/^\/api\/files\/([a-f0-9\-]{36})\/geojson$/i);
    if (gjMatch) {
      return DownloadController.downloadGeoJSON(req, gjMatch[1]);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders(origin) });
  },
});

log("INFO", `Server running at http://localhost:${env.PORT}  CORS: ${env.CORS_ORIGINS.join(", ")}`);
console.log(`🚀 API http://localhost:${env.PORT}  [${scanned} existing file(s) registered]`);

// ── Graceful Shutdown ────────────────────────────────────────

function gracefulShutdown(signal: string) {
  log("INFO", `Received ${signal}. Shutting down gracefully...`);
  terminateAllWorkers();
  closeRedis();
  log("INFO", "Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// ── File Retention Cleanup ───────────────────────────────────

function startRetentionCleanup() {
  const maxAgeMs = env.MAX_FILE_AGE_HOURS * 3600 * 1000;

  function cleanup() {
    const now = Date.now();
    let cleaned = 0;

    // Clean output files (mbtiles, geojson, zip)
    for (const dir of [env.OUTPUT_DIR, env.LOG_DIR]) {
      if (!existsSync(dir)) continue;
      try {
        const files = readdirSync(dir);
        for (const f of files) {
          const ext = f.split(".").pop()?.toLowerCase();
          const isTarget = dir === env.OUTPUT_DIR
            ? ["mbtiles", "geojson", "zip"].includes(ext || "")
            : ["log"].includes(ext || "");
          if (!isTarget) continue;

          const fullPath = join(dir, f);
          try {
            const stat = statSync(fullPath);
            if (now - stat.mtimeMs > maxAgeMs) {
              unlinkSync(fullPath);
              cleaned++;
            }
          } catch { /* file may have been deleted concurrently */ }
        }
      } catch { /* dir read error */ }
    }

    if (cleaned > 0) {
      log("INFO", `Retention cleanup: removed ${cleaned} file(s) older than ${env.MAX_FILE_AGE_HOURS}h`);
    }
  }

  // Run every hour
  setInterval(cleanup, 3600 * 1000);
  // Also run once on startup (delayed by 10s to avoid startup load)
  setTimeout(cleanup, 10_000);
}
