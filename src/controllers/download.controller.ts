import { corsHeaders, json } from "../utils/response";
import { getMBTilesPath, getMBTilesName } from "../services/mbtiles-registry.service";
import { createDownloadStream, createDownloadAllStream, cancelWorkers } from "../services/download-orchestrator.service";
import { getVNDateParts } from "../utils/date";
import { log } from "../utils/logger";
import { ZipStreamer, type ZipEntry } from "../utils/zip";
import { existsSync, statSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { env } from "../config";
import { createHash } from "crypto";

export class DownloadController {
  private static readonly UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

  static async downloadFile(req: Request, fileId: string) {
    const origin = req.headers.get("origin");
    const filePath = getMBTilesPath(fileId);
    if (!filePath) return json({ error: "Not found" }, 404, origin);
    
    const file = Bun.file(filePath);
    if (!await file.exists()) return json({ error: "File missing on disk" }, 404, origin);
    
    const name = getMBTilesName(fileId) || "download.mbtiles";
    return new Response(file, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${name}"`,
        ...corsHeaders(origin),
      },
    });
  }

  static async downloadGeoJSON(req: Request, fileId: string) {
    const origin = req.headers.get("origin");
    const mbPath = getMBTilesPath(fileId);
    if (!mbPath) return json({ error: "Not found" }, 404, origin);
    
    const gjPath = mbPath.replace(".mbtiles", ".geojson");
    const gjFile = Bun.file(gjPath);
    if (!await gjFile.exists()) return json({ error: "GeoJSON not found" }, 404, origin);
    
    const gjName = (getMBTilesName(fileId) || "download.mbtiles").replace(".mbtiles", ".geojson");
    return new Response(gjFile, {
      headers: {
        "Content-Type": "application/geo+json",
        "Content-Disposition": `attachment; filename="${gjName}"`,
        ...corsHeaders(origin),
      },
    });
  }

  static async downloadBundle(req: Request, url: URL) {
    const origin = req.headers.get("origin");
    const rawIds = (url.searchParams.get("ids") || "").split(",").map(s => s.trim()).filter(Boolean);
    const ids = Array.from(new Set(rawIds)).filter(s => this.UUID_RE.test(s));
    if (ids.length === 0) return json({ error: "No IDs" }, 400, origin);
    if (ids.length > env.MAX_BUNDLE_IDS) {
      return json({ error: "Too many IDs", max: env.MAX_BUNDLE_IDS }, 400, origin);
    }

    const zipEntries: ZipEntry[] = [];
    for (const id of ids) {
      const p = getMBTilesPath(id);
      const n = getMBTilesName(id);
      if (p && n && existsSync(p)) {
        const stat = statSync(p);
        zipEntries.push({ path: p, name: n, size: stat.size, mtimeMs: stat.mtimeMs });
        const gjPath = p.replace(".mbtiles", ".geojson");
        if (existsSync(gjPath)) {
          const gjStat = statSync(gjPath);
          zipEntries.push({ path: gjPath, name: n.replace(".mbtiles", ".geojson"), size: gjStat.size, mtimeMs: gjStat.mtimeMs });
        }
      }
    }
    if (zipEntries.length === 0) return json({ error: "No files found" }, 404, origin);

    const { timestamp } = getVNDateParts();
    const totalSize = ZipStreamer.calculateTotalSize(zipEntries);
    if (totalSize > env.MAX_BUNDLE_BYTES) {
      return json({ error: "Bundle too large", maxBytes: env.MAX_BUNDLE_BYTES }, 413, origin);
    }

    const hash = createHash("sha256");
    for (const entry of zipEntries) {
      hash.update(entry.path);
      hash.update(String(entry.size));
      hash.update(String(entry.mtimeMs));
    }
    const cacheKey = hash.digest("hex").slice(0, 16);
    const cachePath = join(env.OUTPUT_DIR, `bundle_${cacheKey}.zip`);

    if (existsSync(cachePath)) {
      const cached = Bun.file(cachePath);
      return new Response(cached, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="hcm-tiles-${timestamp}.zip"`,
          "Content-Length": String(statSync(cachePath).size),
          "Cache-Control": "public, max-age=3600",
          "ETag": `"${cacheKey}"`,
          ...corsHeaders(origin),
        },
      });
    }

    const stream = ZipStreamer.createStream(zipEntries);
    const [respStream, cacheStream] = stream.tee();
    const tmpPath = `${cachePath}.tmp`;
    Bun.write(tmpPath, cacheStream)
      .then(() => {
        try {
          if (!existsSync(cachePath)) {
            renameSync(tmpPath, cachePath);
          } else {
            unlinkSync(tmpPath);
          }
        } catch {
          try { unlinkSync(tmpPath); } catch { }
        }
      })
      .catch(() => {
        try { unlinkSync(tmpPath); } catch { }
      });

    return new Response(respStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="hcm-tiles-${timestamp}.zip"`,
        "Content-Length": String(totalSize),
        "Cache-Control": "public, max-age=3600",
        "ETag": `"${cacheKey}"`,
        ...corsHeaders(origin),
      },
    });
  }

  static async cancelJobs(req: Request, url: URL) {
    const origin = req.headers.get("origin");
    const token = (await req.text()) || url.searchParams.get("token") || "";
    if (!token) return json({ error: "No token" }, 400, origin);
    const n = cancelWorkers(token);
    return json({ cancelled: n }, 200, origin);
  }

  static streamDownloadAll(req: Request, url: URL) {
    const origin = req.headers.get("origin");
    const geojson = url.searchParams.get("geojson") === "true";
    const token = url.searchParams.get("token") || null;
    return new Response(createDownloadAllStream(geojson, token), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...corsHeaders(origin) },
    });
  }

  static streamDownload(req: Request, url: URL) {
    const origin = req.headers.get("origin");
    const keys = (url.searchParams.get("keys") || "").split(",").filter(Boolean);
    const geojson = url.searchParams.get("geojson") === "true";
    const token = url.searchParams.get("token") || null;
    if (keys.length === 0) return json({ error: "No keys" }, 400, origin);
    return new Response(createDownloadStream(keys, geojson, token), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...corsHeaders(origin) },
    });
  }
}
