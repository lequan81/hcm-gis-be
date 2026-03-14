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

  private static buildBundleMeta(origin: string | null, url: URL):
    | { zipEntries: ZipEntry[]; totalSize: number; cacheKey: string; cachePath: string; tmpPath: string; timestamp: string }
    | Response {
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

    const totalSize = ZipStreamer.calculateTotalSize(zipEntries);
    if (totalSize > env.MAX_BUNDLE_BYTES) {
      return json({ error: "Bundle too large", maxBytes: env.MAX_BUNDLE_BYTES }, 413, origin);
    }

    const { timestamp } = getVNDateParts();
    const hash = createHash("sha256");
    for (const entry of zipEntries) {
      hash.update(entry.path);
      hash.update(String(entry.size));
      hash.update(String(entry.mtimeMs));
    }
    const cacheKey = hash.digest("hex").slice(0, 16);
    const cachePath = join(env.OUTPUT_DIR, `bundle_${cacheKey}.zip`);
    const tmpPath = `${cachePath}.tmp`;

    return { zipEntries, totalSize, cacheKey, cachePath, tmpPath, timestamp };
  }

  private static parseRange(rangeHeader: string | null, size: number): { start: number; end: number } | "invalid" | null {
    if (!rangeHeader) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match) return null;
    const startRaw = match[1];
    const endRaw = match[2];
    if (!startRaw && !endRaw) return "invalid";
    let start = 0;
    let end = size - 1;
    if (!startRaw) {
      const suffix = Number(endRaw);
      if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
      start = Math.max(0, size - suffix);
    } else {
      start = Number(startRaw);
      if (!Number.isFinite(start) || start < 0) return "invalid";
      if (endRaw) {
        end = Number(endRaw);
        if (!Number.isFinite(end) || end < 0) return "invalid";
      }
    }
    if (start >= size || end < start) return "invalid";
    if (end >= size) end = size - 1;
    return { start, end };
  }

  private static fileResponse(
    req: Request,
    origin: string | null,
    filePath: string,
    fileName: string,
    contentType: string
  ): Response {
    const stat = statSync(filePath);
    const size = stat.size;
    const range = this.parseRange(req.headers.get("range"), size);
    if (range === "invalid") {
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${size}`,
          "Accept-Ranges": "bytes",
          ...corsHeaders(origin),
        },
      });
    }
    if (range) {
      const slice = Bun.file(filePath).slice(range.start, range.end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Content-Length": String(range.end - range.start + 1),
          "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
          "Accept-Ranges": "bytes",
          ...corsHeaders(origin),
        },
      });
    }

    const file = Bun.file(filePath);
    return new Response(file, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
        ...corsHeaders(origin),
      },
    });
  }

  private static rangeFromPartial(
    req: Request,
    origin: string | null,
    filePath: string,
    fileName: string,
    contentType: string,
    fullSize: number
  ): Response | null {
    const stat = statSync(filePath);
    const size = stat.size;
    const range = this.parseRange(req.headers.get("range"), fullSize);
    if (!range || range === "invalid") return null;
    if (range.start >= size) {
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${fullSize}`,
          "Accept-Ranges": "bytes",
          "Retry-After": "5",
          ...corsHeaders(origin),
        },
      });
    }
    const end = Math.min(range.end, size - 1);
    const slice = Bun.file(filePath).slice(range.start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${end}/${fullSize}`,
        "Accept-Ranges": "bytes",
        ...corsHeaders(origin),
      },
    });
  }

  static async downloadFile(req: Request, fileId: string) {
    const origin = req.headers.get("origin");
    const filePath = getMBTilesPath(fileId);
    if (!filePath) return json({ error: "Not found" }, 404, origin);
    
    const file = Bun.file(filePath);
    if (!await file.exists()) return json({ error: "File missing on disk" }, 404, origin);
    
    const name = getMBTilesName(fileId) || "download.mbtiles";
    return this.fileResponse(req, origin, filePath, name, "application/octet-stream");
  }

  static async downloadGeoJSON(req: Request, fileId: string) {
    const origin = req.headers.get("origin");
    const mbPath = getMBTilesPath(fileId);
    if (!mbPath) return json({ error: "Not found" }, 404, origin);
    
    const gjPath = mbPath.replace(".mbtiles", ".geojson");
    const gjFile = Bun.file(gjPath);
    if (!await gjFile.exists()) return json({ error: "GeoJSON not found" }, 404, origin);
    
    const gjName = (getMBTilesName(fileId) || "download.mbtiles").replace(".mbtiles", ".geojson");
    return this.fileResponse(req, origin, gjPath, gjName, "application/geo+json");
  }

  static async downloadBundle(req: Request, url: URL) {
    const origin = req.headers.get("origin");
    const meta = this.buildBundleMeta(origin, url);
    if (meta instanceof Response) return meta;
    const { zipEntries, totalSize, cacheKey, cachePath, tmpPath, timestamp } = meta;

    if (existsSync(cachePath)) {
      return this.fileResponse(
        req,
        origin,
        cachePath,
        `hcm-tiles-${timestamp}.zip`,
        "application/zip"
      );
    }

    const hasRange = !!req.headers.get("range");
    if (hasRange && existsSync(tmpPath)) {
      const partial = this.rangeFromPartial(
        req,
        origin,
        tmpPath,
        `hcm-tiles-${timestamp}.zip`,
        "application/zip",
        totalSize
      );
      if (partial) return partial;
    }

    const stream = ZipStreamer.createStream(zipEntries);
    const [respStream, cacheStream] = stream.tee();
    if (!existsSync(tmpPath)) {
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
    }

    return new Response(respStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="hcm-tiles-${timestamp}.zip"`,
        "Content-Length": String(totalSize),
        "Cache-Control": "public, max-age=3600",
        "ETag": `"${cacheKey}"`,
        "Accept-Ranges": "bytes",
        ...corsHeaders(origin),
      },
    });
  }

  static async prepareBundle(req: Request, url: URL) {
    const origin = req.headers.get("origin");
    const meta = this.buildBundleMeta(origin, url);
    if (meta instanceof Response) return meta;
    const { zipEntries, totalSize, cacheKey, cachePath, tmpPath, timestamp } = meta;

    if (existsSync(cachePath)) {
      return json({ status: "ready", cacheKey, size: statSync(cachePath).size }, 200, origin);
    }

    if (existsSync(tmpPath)) {
      // Wait briefly for an in-progress build to finish.
      const start = Date.now();
      while (Date.now() - start < 30000) {
        if (existsSync(cachePath)) {
          return json({ status: "ready", cacheKey, size: statSync(cachePath).size }, 200, origin);
        }
        await Bun.sleep(250);
      }
      return json({ status: "building", cacheKey }, 202, origin);
    }

    const stream = ZipStreamer.createStream(zipEntries);
    await Bun.write(tmpPath, stream);
    try {
      if (!existsSync(cachePath)) {
        renameSync(tmpPath, cachePath);
      } else {
        unlinkSync(tmpPath);
      }
    } catch {
      try { unlinkSync(tmpPath); } catch { }
    }

    const size = existsSync(cachePath) ? statSync(cachePath).size : totalSize;
    return json({ status: "ready", cacheKey, size, filename: `hcm-tiles-${timestamp}.zip` }, 200, origin);
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
