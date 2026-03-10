/**
 * HCMC 3D Building Tiles — API Server
 *
 * Thin router that delegates to single-responsibility modules:
 *   env.ts             — config from .env
 *   logger.ts          — file + console logging
 *   response.ts        — CORS / JSON helpers
 *   districts.ts       — district data + tile math
 *   mbtiles.ts         — MBTilesWriter (SQLite)
 *   mbtiles-registry.ts — open DB registry + file serving
 *   download-service.ts — SSE download orchestration
 *   download-worker.ts  — Worker thread for fetching
 *   beep.ts            — notification WAV generator
 */

import { existsSync, mkdirSync } from "fs";
import archiver from "archiver";
import { env } from "./env";
import { log } from "./logger";
import { corsHeaders, json } from "./response";
import { DISTRICTS, getTilesForDistrict, URBAN_KEYS, ALL_KEYS } from "./districts";
import { getMBTilesPath, getMBTilesName } from "./mbtiles-registry";
import { createDownloadStream, createDownloadAllStream, cancelWorkers } from "./download-service";

// ── Bootstrap ────────────────────────────────────────────────

for (const d of [env.OUTPUT_DIR, env.LOG_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

const districtInfos = ALL_KEYS.map(key => {
  const d = DISTRICTS[key];
  const { tiles } = getTilesForDistrict(key, env.ZOOM, env.TILE_OVERLAP);
  return { key, name: d.name, tiles: tiles.length, bbox: d.bbox };
});

// ── Server ───────────────────────────────────────────────────

Bun.serve({
  port: env.PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = req.headers.get("origin");

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── API: districts ──
    if (path === "/api/districts") {
      return json({ districts: districtInfos, urbanKeys: URBAN_KEYS, allKeys: ALL_KEYS }, 200, origin);
    }

    // ── API: file download ──
    const fileMatch = path.match(/^\/api\/files\/(\d+)$/);
    if (fileMatch) {
      const filePath = getMBTilesPath(fileMatch[1]);
      if (!filePath) return json({ error: "Not found" }, 404, origin);
      const file = Bun.file(filePath);
      if (!await file.exists()) return json({ error: "File missing" }, 404, origin);
      const name = getMBTilesName(fileMatch[1]) || "download.mbtiles";
      return new Response(file, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${name}"`,
          ...corsHeaders(origin),
        },
      });
    }

    // ── API: geojson file download ──
    const gjMatch = path.match(/^\/api\/files\/(\d+)\/geojson$/);
    if (gjMatch) {
      const mbPath = getMBTilesPath(gjMatch[1]);
      if (!mbPath) return json({ error: "Not found" }, 404, origin);
      const gjPath = mbPath.replace(".mbtiles", ".geojson");
      const gjFile = Bun.file(gjPath);
      if (!await gjFile.exists()) return json({ error: "GeoJSON not found" }, 404, origin);
      const gjName = (getMBTilesName(gjMatch[1]) || "download.mbtiles").replace(".mbtiles", ".geojson");
      return new Response(gjFile, {
        headers: {
          "Content-Type": "application/geo+json",
          "Content-Disposition": `attachment; filename="${gjName}"`,
          ...corsHeaders(origin),
        },
      });
    }

    // ── API: bundle (zip) download ──
    if (path === "/api/bundle" && req.method === "GET") {
      const ids = (url.searchParams.get("ids") || "").split(",").filter(s => /^\d+$/.test(s));
      if (ids.length === 0) return json({ error: "No IDs" }, 400, origin);

      const files: { path: string; name: string }[] = [];
      for (const id of ids) {
        const p = getMBTilesPath(id);
        const n = getMBTilesName(id);
        if (p && n) {
          files.push({ path: p, name: n });
          const gjPath = p.replace(".mbtiles", ".geojson");
          if (existsSync(gjPath)) {
            files.push({ path: gjPath, name: n.replace(".mbtiles", ".geojson") });
          }
        }
      }
      if (files.length === 0) return json({ error: "No files found" }, 404, origin);

      const archive = archiver("zip", { zlib: { level: 1 } });
      for (const f of files) archive.file(f.path, { name: f.name });
      archive.finalize();

      const stream = new ReadableStream({
        start(controller) {
          archive.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          archive.on("end", () => controller.close());
          archive.on("error", (err) => controller.error(err));
        },
      });

      // Use Vietnam local time for bundle file name
      function getVNDateParts() {
        const now = new Date();
        const opts = { timeZone: 'Asia/Ho_Chi_Minh', hour12: false };
        return now.toLocaleDateString('vi-VN', opts).split('/').reverse().map(s => s.padStart(2, '0')).join('');
      }
      const ts = getVNDateParts();
      return new Response(stream, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="hcm-tiles-${ts}.zip"`,
          ...corsHeaders(origin),
        },
      });
    }

    // ── API: cancel workers by token ──
    if (path === "/api/cancel" && req.method === "POST") {
      const token = (await req.text()) || url.searchParams.get("token") || "";
      if (!token) return json({ error: "No token" }, 400, origin);
      const n = cancelWorkers(token);
      return json({ cancelled: n }, 200, origin);
    }

    // ── API: SSE download all ──
    if (path === "/api/download-all" && req.method === "GET") {
      const geojson = url.searchParams.get("geojson") === "true";
      const token = url.searchParams.get("token") || null;
      return new Response(createDownloadAllStream(geojson, token), {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...corsHeaders(origin) },
      });
    }

    // ── API: SSE download ──
    if (path === "/api/download" && req.method === "GET") {
      const keys = (url.searchParams.get("keys") || "").split(",").filter(Boolean);
      const geojson = url.searchParams.get("geojson") === "true";
      const token = url.searchParams.get("token") || null;
      if (keys.length === 0) return json({ error: "No keys" }, 400, origin);
      return new Response(createDownloadStream(keys, geojson, token), {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...corsHeaders(origin) },
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders(origin) });
  },
});

log("INFO", `API server at http://localhost:${env.PORT}  CORS: ${env.CORS_ORIGINS.join(", ")}`);
console.log(`🚀 API http://localhost:${env.PORT}`);
