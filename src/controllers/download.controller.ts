import { corsHeaders, json } from "../utils/response";
import { getMBTilesPath, getMBTilesName } from "../services/mbtiles-registry.service";
import { createDownloadStream, createDownloadAllStream, cancelWorkers } from "../services/download-orchestrator.service";
import { getVNDateParts } from "../utils/date";
import { log } from "../utils/logger";
import archiver from "archiver";
import { existsSync, createWriteStream } from "fs";
import { join } from "path";
import { env } from "../config";

export class DownloadController {

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
    const ids = (url.searchParams.get("ids") || "").split(",").filter(s => /^[a-f0-9\-]+$/i.test(s));
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

    const zipId = crypto.randomUUID();
    const zipPath = join(env.OUTPUT_DIR, `hcm-bundle-${zipId}.zip`);

    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(zipPath);
      const archive = archiver("zip", { store: true }); // MBTiles are already compressed
      
      output.on("close", () => resolve());
      archive.on("warning", (err) => log("WARN", `Archiver: ${err.message}`));
      archive.on("error", (err) => {
        log("ERROR", `Archiver error: ${err.message}`);
        reject(err);
      });

      archive.pipe(output);
      for (const f of files) archive.file(f.path, { name: f.name });
      archive.finalize();
    });

    const file = Bun.file(zipPath);
    const { timestamp } = getVNDateParts();
    
    return new Response(file, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="hcm-tiles-${timestamp}.zip"`,
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
