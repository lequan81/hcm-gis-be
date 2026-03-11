/**
 * HCMC 3D Building Tiles — API Server (SOLID)
 */

import { existsSync, mkdirSync } from "fs";
import { env } from "./config";
import { log } from "./utils/logger";
import { corsHeaders, json } from "./utils/response";
import { scanOutputDirectory, startRegistryCleanupWatcher } from "./services/mbtiles-registry.service";
import { DistrictsController } from "./controllers/districts.controller";
import { DownloadController } from "./controllers/download.controller";
import { RateLimiter } from "./utils/rate-limiter";

const rateLimiter = new RateLimiter(60000, 45);

// ── Bootstrap ────────────────────────────────────────────────

for (const d of [env.OUTPUT_DIR, env.LOG_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// 1. Pre-register existing mbtiles files on startup
const scanned = scanOutputDirectory();

// 2. Start the registry watcher to close handles of deleted files
startRegistryCleanupWatcher();

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

    // ── API: SSE download all ──
    if (path === "/api/download-all" && req.method === "GET") {
      if (rateLimiter.isRateLimited(ip)) return json({ error: "Too many requests" }, 429, origin);
      return DownloadController.streamDownloadAll(req, url);
    }

    // ── API: SSE download specific districts ──
    if (path === "/api/download" && req.method === "GET") {
      if (rateLimiter.isRateLimited(ip)) return json({ error: "Too many requests" }, 429, origin);
      return DownloadController.streamDownload(req, url);
    }

    // ── API: file endpoints (UUID matched) ──
    // e.g., /api/files/123e4567-e89b-12d3-a456-426614174000
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
