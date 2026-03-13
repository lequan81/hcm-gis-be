/**
 * Download worker — runs in its own Bun thread via `new Worker()`.
 *
 * Receives: { districtKey, zoom, overlap, geojson, outputDir, concurrency, apiUrl, referer, origin, retryDelay, sleepMs, batchSize }
 * Posts back: ProgressInfo messages and a final DownloadOutput | null.
 */

declare var self: Worker;

import { existsSync, mkdirSync, unlinkSync, appendFileSync } from "fs";
import { join } from "path";
import { log } from "../utils/logger";
import { MBTilesWriter } from "../utils/mbtiles";
import { DISTRICTS, getTilesForDistrict } from "../utils/districts";
import { getVNDateParts } from "../utils/date";
import type { WorkerInput, TileResult } from "../types/worker";

function tileToLonLat(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const lonMin = (x / n) * 360 - 180;
  const lonMax = ((x + 1) / n) * 360 - 180;
  const latMaxRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const latMinRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  return [lonMin, latMinRad * 180 / Math.PI, lonMax, latMaxRad * 180 / Math.PI];
}

function computeCentroid(geometry: { type: string; coordinates: any }): [number, number] | null {
  try {
    let ring: number[][];
    if (geometry.type === "Polygon") ring = geometry.coordinates[0];
    else if (geometry.type === "MultiPolygon") ring = geometry.coordinates[0][0];
    else return null;
    let cx = 0, cy = 0;
    for (const [x, y] of ring) { cx += x; cy += y; }
    return [cx / ring.length, cy / ring.length];
  } catch { return null; }
}

let cancelled = false;

// listen for cancel messages
self.addEventListener("message", (e: MessageEvent) => {
  if (e.data && (e.data as any).type === "cancel") {
    cancelled = true;
  }
});

// ── Per-job log helper ──
function createJobLog(logDir: string, districtKey: string): (msg: string) => void {
  const { timestamp } = getVNDateParts();
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `download_${districtKey}_${timestamp}.log`);
  return (msg: string) => {
    const { date: d, time: t } = getVNDateParts();
    const line = `[${d} ${t}] ${msg}`;
    try { appendFileSync(logFile, line + "\n"); } catch { }
  };
}

// Patch: Accept LOG_DIR/LOG_FILE from message and set process.env before importing logger
self.onmessage = async (event: MessageEvent<WorkerInput & { LOG_DIR?: string, LOG_FILE?: string }>) => {
  if (event.data && event.data.LOG_DIR) {
    process.env.LOG_DIR = event.data.LOG_DIR;
  }
  if (event.data && event.data.LOG_FILE) {
    process.env.LOG_FILE = event.data.LOG_FILE;
  }
  if (event.data && (event.data as any).type === "cancel") { cancelled = true; return; }

  const { districtKey, zoom, overlap, geojson, outputDir, concurrency, apiUrl, referer, origin, retryDelay,
    sleepMs = 10, batchSize = 1000 } = event.data;

  const d = DISTRICTS[districtKey];
  if (!d) { self.postMessage({ type: "result", data: null }); return; }

  // Create per-job log
  const logDir = event.data.LOG_DIR || "./logs";
  const jobLog = createJobLog(logDir, districtKey);
  jobLog(`Download started: ${districtKey} (${d.name})`);
  jobLog(`Config: zoom=${zoom} overlap=${overlap} geojson=${geojson} concurrency=${concurrency} sleepMs=${sleepMs} batchSize=${batchSize}`);
  log("INFO", `Worker start: district=${districtKey}`);

  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0",
    Referer: referer,
    Origin: origin,
  };

  const { tiles } = getTilesForDistrict(districtKey, zoom, overlap);
  const t0 = performance.now();
  const total = tiles.length;
  const results: TileResult[] = [];
  let idx = 0, done = 0, ok = 0, fail = 0;

  jobLog(`Tiles to fetch: ${total}`);

  const send = (phase: string) => {
    self.postMessage({ type: "progress", data: { done, total, ok, fail, phase, district: districtKey } });
  };
  send("downloading");

  async function fetchTile(z: number, x: number, y: number) {
    const url = `${apiUrl}/${z}/${x}/${y}`;
    try {
      let res = await fetch(url, { headers });
      if (res.status === 404) {
        await Bun.sleep(retryDelay);
        res = await fetch(url, { headers });
        if (res.status === 404) return null;
      }
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch { return null; }
  }

  async function worker() {
    while (true) {
      if (cancelled) break;
      const i = idx++;
      if (i >= total) break;
      const [z, x, y] = tiles[i];
      const data = await fetchTile(z, x, y);
      if (cancelled) break;
      if (data) { results.push({ z, x, y, data }); ok++; } else { fail++; }
      done++;
      if (done % 2 === 0) send("downloading");
      if (sleepMs > 0) await Bun.sleep(sleepMs + Math.random() * (sleepMs * 0.3));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  send("downloading");

  if (cancelled) {
    jobLog(`Cancelled early. ok=${ok} fail=${fail}`);
    log("INFO", `Worker cancelled early: ${districtKey}`);
    self.postMessage({ type: "result", data: null });
    return;
  }

  if (results.length === 0) {
    jobLog(`No tiles fetched. fail=${fail}`);
    self.postMessage({ type: "result", data: null });
    return;
  }

  // Write MBTiles
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const { timestamp } = getVNDateParts();
  const uuid = crypto.randomUUID();
  const mbtilesPath = join(outputDir, `hcm_${districtKey}_${timestamp}_${uuid}.mbtiles`);

  send("writing_mbtiles");
  const writer = new MBTilesWriter(mbtilesPath, {
    name: `HCMC ${d.name} Buildings`,
    description: `Building tiles for ${d.name}`,
    format: "pbf",
    type: "overlay",
    bounds: d.bbox.join(","),
    center: `${(d.bbox[0] + d.bbox[2]) / 2},${(d.bbox[1] + d.bbox[3]) / 2},${zoom}`,
    minzoom: String(zoom),
    maxzoom: String(zoom),
    json: JSON.stringify({
      vector_layers: [{
        id: "region_building3d_index", description: `${d.name} buildings`,
        fields: { height: "Number", base_height: "Number", landmark: "String", madoituong: "String" }
      }],
    }),
  });

  for (let i = 0; i < results.length; i += batchSize) {
    if (cancelled) break;
    writer.writeBatch(results.slice(i, i + batchSize));
  }
  if (cancelled) {
    log("INFO", `Worker cancelled during write: ${districtKey}`);
    jobLog(`Cancelled during write`);
    try { writer.close(); } catch { }
    try { unlinkSync(mbtilesPath); } catch { }
    self.postMessage({ type: "result", data: null });
    return;
  }
  writer.close();

  const elapsed = (performance.now() - t0) / 1000;
  const sizeMB = (Bun.file(mbtilesPath).size / 1048576).toFixed(1);

  const output: any = {
    mbtilesPath,
    tileCount: writer.count,
    elapsed,
    sizeMB,
  };

  // GeoJSON extraction
  if (geojson) {
    send("extracting_geojson");
    const { VectorTile } = await import("@mapbox/vector-tile");
    const Pbf = (await import("pbf")).default;
    const features: any[] = [];
    for (const { z, x, y, data } of results) {
      const [tileW, tileS, tileE, tileN] = tileToLonLat(z, x, y);
      const tile = new VectorTile(new Pbf(data));
      for (const ln of Object.keys(tile.layers)) {
        const layer = tile.layers[ln];
        if (!ln.toLowerCase().includes("building")) continue;
        for (let i = 0; i < layer.length; i++) {
          const gj = layer.feature(i).toGeoJSON(x, y, z);
          const c = computeCentroid(gj.geometry as any);
          if (!c) continue;
          if (c[0] < tileW || c[0] >= tileE || c[1] < tileS || c[1] >= tileN) continue;
          features.push({ type: "Feature", geometry: gj.geometry, properties: gj.properties });
        }
      }
    }
    const gjPath = mbtilesPath.replace(".mbtiles", ".geojson");
    await Bun.write(gjPath, JSON.stringify({ type: "FeatureCollection", features }));
    output.featureCount = features.length;
    output.geojsonPath = gjPath;
    jobLog(`GeoJSON: ${features.length} features → ${gjPath}`);
  }

  // Write summary to per-job log
  jobLog(`--- SUMMARY ---`);
  jobLog(`District: ${districtKey} (${d.name})`);
  jobLog(`Tiles: ${ok} ok, ${fail} fail, ${total} total`);
  jobLog(`Output: ${mbtilesPath} (${sizeMB} MB)`);
  jobLog(`Elapsed: ${elapsed.toFixed(1)}s`);
  if (output.featureCount !== undefined) jobLog(`GeoJSON features: ${output.featureCount}`);
  jobLog(`--- END ---`);

  log("INFO", `Worker done: ${districtKey} tiles=${output.tileCount} sizeMB=${output.sizeMB}`);
  self.postMessage({ type: "result", data: output });
};
