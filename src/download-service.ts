import { env } from "./env";
import { ENABLE_CLEANUP } from "./env";
import { log } from "./logger";
import { registerMBTiles, unregisterMBTilesByPath } from "./mbtiles-registry";
import { readdirSync, statSync, unlinkSync } from "fs";

// Track workers by token so they can be cancelled from an external request
const workerMap = new Map<string, Worker[]>();

export function cancelWorkers(token: string) {
  const arr = workerMap.get(token);
  if (!arr) return 0;
  let n = 0;
  // Signal workers to cancel cooperatively
  for (const w of arr) {
    try { w.postMessage({ type: "cancel" }); n++; } catch { }
  }
  log("INFO", `Cancel requested for token ${token}: signaled ${n} worker(s)`);

  // After a short grace period, force-terminate any remaining workers
  setTimeout(() => {
    const remaining = workerMap.get(token) || [];
    let terminated = 0;
    for (const w of remaining) {
      try { w.terminate(); terminated++; } catch { }
    }
    workerMap.delete(token);
    log("INFO", `Cancel completed for token ${token}: force-terminated ${terminated} worker(s)`);
  }, 2000);

  return n;
}

function registerWorker(token: string | null, w: Worker) {
  if (!token) return;
  const a = workerMap.get(token) || [];
  a.push(w);
  workerMap.set(token, a);
}

export function createDownloadAllStream(geojson: boolean, token: string | null = null): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (data: Record<string, unknown>) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { }
      };

      log("INFO", "Download ALL started");
      try {
        const worker = new Worker(new URL("./download-all-worker.ts", import.meta.url).href);
        registerWorker(token, worker);
        const result = await new Promise<any>((res) => {
          worker.onmessage = (e: MessageEvent) => {
            if (e.data.type === "progress") send(e.data.data);
            else if (e.data.type === "result") res(e.data.data);
          };
          worker.onerror = (err) => { log("ERROR", `Worker error: ${err.message}`); res(null); };
          worker.postMessage({
            zoom: env.ZOOM, overlap: env.TILE_OVERLAP,
            geojson, outputDir: env.OUTPUT_DIR, concurrency: env.CONCURRENCY,
            apiUrl: env.TILE_API_URL, referer: env.TILE_REFERER,
            origin: env.TILE_ORIGIN, retryDelay: env.RETRY_DELAY_MS,
            LOG_DIR: env.LOG_DIR,
            LOG_FILE: process.env.LOG_FILE,
          });
        });
        if (result) {
          const id = registerMBTiles(result.mbtilesPath);
          log("INFO", `Download ALL done → #${id} (${result.tileCount} tiles, ${result.sizeMB} MB)`);
          send({
            phase: "done_district", district: "all", id,
            tileCount: result.tileCount, sizeMB: result.sizeMB, elapsed: result.elapsed.toFixed(1)
          });
        }
        try { worker.terminate(); } catch { }
        if (token) {
          const a = workerMap.get(token) || [];
          workerMap.set(token, a.filter(x => x !== worker));
        }
      } catch (err: any) {
        log("ERROR", `Download ALL failed: ${err?.message}`);
        send({ phase: "error", message: "Download ALL failed" });
      }
      send({ phase: "done", message: "Finished downloading all HCM tiles" });
      controller.close();
    },
  });
}

export function createDownloadStream(keys: string[], geojson: boolean, token: string | null = null): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (data: Record<string, unknown>) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { }
      };

      for (const key of keys) {
        log("INFO", `Download started: ${key}`);
        try {
          const worker = new Worker(new URL("./download-worker.ts", import.meta.url).href);
          registerWorker(token, worker);
          const result = await new Promise<any>((res) => {
            worker.onmessage = (e: MessageEvent) => {
              if (e.data.type === "progress") send(e.data.data);
              else if (e.data.type === "result") res(e.data.data);
            };
            worker.onerror = (err) => { log("ERROR", `Worker error: ${err.message}`); res(null); };
            worker.postMessage({
              districtKey: key, zoom: env.ZOOM, overlap: env.TILE_OVERLAP,
              geojson, outputDir: env.OUTPUT_DIR, concurrency: env.CONCURRENCY,
              apiUrl: env.TILE_API_URL, referer: env.TILE_REFERER,
              origin: env.TILE_ORIGIN, retryDelay: env.RETRY_DELAY_MS,
              LOG_DIR: env.LOG_DIR,
              LOG_FILE: process.env.LOG_FILE,
            });
          });
          if (result) {
            const id = registerMBTiles(result.mbtilesPath);
            log("INFO", `Download done: ${key} → #${id} (${result.tileCount} tiles, ${result.sizeMB} MB)`);
            send({
              phase: "done_district", district: key, id,
              tileCount: result.tileCount, sizeMB: result.sizeMB, elapsed: result.elapsed.toFixed(1)
            });
          }
          try { worker.terminate(); } catch { }
          if (token) {
            const a = workerMap.get(token) || [];
            workerMap.set(token, a.filter(x => x !== worker));
          }
        } catch (err: any) {
          log("ERROR", `Download failed: ${key}: ${err?.message}`);
          send({ phase: "error", message: `Failed: ${key}` });
        }
      }
      send({ phase: "done", message: `Finished ${keys.length} district(s)` });
      controller.close();
    },
  });
}


