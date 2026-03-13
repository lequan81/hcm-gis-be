/**
 * Download Orchestrator Service
 * 
 * Uses a FIXED WORKER POOL (max 3 threads) to prevent OOM on the RK3318 (2GB RAM).
 * Districts are queued and dispatched to idle workers sequentially.
 * The "download all" path uses a single dedicated worker (download-all.worker).
 */

import { env } from "../config";
import { log } from "../utils/logger";
import { registerMBTiles } from "./mbtiles-registry.service";

const MAX_POOL_SIZE = env.WORKER_POOL_SIZE || 3;
const cancelledTokens = new Set<string>();

/**
 * Resolve the correct worker script URL for both .ts dev and .js prod.
 */
function getWorkerUrl(filename: string): URL {
  const isProd = process.env.NODE_ENV === "production" || import.meta.url.endsWith(".js");
  // In dev: src/services/ -> ../workers/*.ts
  // In prod: dist/main.js -> ./workers/*.js
  const path = isProd ? `./workers/${filename}.js` : `../workers/${filename}.ts`;
  return new URL(path, import.meta.url);
}

/**
 * Run a single job on a fresh worker thread. Returns a Promise that resolves
 * when the worker posts a "result" message.
 */
function runWorkerJob(
  workerFile: string,
  payload: Record<string, unknown>,
  onProgress: (data: Record<string, unknown>) => void,
  token: string | null
): Promise<any> {
  return new Promise((resolve) => {
    const worker = new Worker(getWorkerUrl(workerFile));

    // If token was already cancelled before we even started, signal immediately
    if (token && cancelledTokens.has(token)) {
      worker.postMessage({ type: "cancel" });
    }

    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === "progress") {
        onProgress(e.data.data);
      } else if (e.data.type === "result") {
        try { worker.terminate(); } catch { }
        resolve(e.data.data);
      }
    };

    worker.onerror = (err) => {
      log("ERROR", `Worker error: ${err.message}`);
      try { worker.terminate(); } catch { }
      resolve(null);
    };

    // Store worker reference for cancellation
    if (token) {
      const existing = activeWorkers.get(token) || [];
      existing.push(worker);
      activeWorkers.set(token, existing);
    }

    worker.postMessage(payload);
  });
}

// Track active workers per cancel token
const activeWorkers = new Map<string, Worker[]>();

export function cancelWorkers(token: string) {
  cancelledTokens.add(token);

  const arr = activeWorkers.get(token);
  if (!arr) return 0;
  let n = 0;
  for (const w of arr) {
    try { w.postMessage({ type: "cancel" }); n++; } catch { }
  }
  log("INFO", `Cancel requested for token ${token}: signaled ${n} worker(s)`);

  // Force-terminate after 2s grace period
  setTimeout(() => {
    const remaining = activeWorkers.get(token) || [];
    let terminated = 0;
    for (const w of remaining) {
      try { w.terminate(); terminated++; } catch { }
    }
    activeWorkers.delete(token);
    cancelledTokens.delete(token);
    log("INFO", `Cancel completed for token ${token}: force-terminated ${terminated} worker(s)`);
  }, 2000);

  return n;
}

/**
 * Terminate ALL active workers across all tokens (for graceful shutdown).
 */
export function terminateAllWorkers(): number {
  let terminated = 0;
  for (const [token, arr] of activeWorkers.entries()) {
    for (const w of arr) {
      try { w.terminate(); terminated++; } catch { }
    }
    activeWorkers.delete(token);
  }
  cancelledTokens.clear();
  if (terminated > 0) log("INFO", `Shutdown: force-terminated ${terminated} worker(s)`);
  return terminated;
}

function getCommonPayload(geojson: boolean) {
  return {
    zoom: env.ZOOM,
    overlap: env.TILE_OVERLAP,
    geojson,
    outputDir: env.OUTPUT_DIR,
    concurrency: env.CONCURRENCY,
    apiUrl: env.TILE_API_URL,
    referer: env.TILE_REFERER,
    origin: env.TILE_ORIGIN,
    retryDelay: env.RETRY_DELAY_MS,
    sleepMs: env.TILE_SLEEP_MS,
    batchSize: env.TILE_BATCH_SIZE,
    LOG_DIR: env.LOG_DIR,
    LOG_FILE: process.env.LOG_FILE,
  };
}

// ── Download ALL (single big worker) ──

export function createDownloadAllStream(geojson: boolean, token: string | null = null): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (data: Record<string, unknown>) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { }
      };

      log("INFO", "Download ALL started");
      try {
        const result = await runWorkerJob(
          "download-all.worker",
          getCommonPayload(geojson),
          send,
          token
        );

        if (result) {
          const id = registerMBTiles(result.mbtilesPath);
          log("INFO", `Download ALL done → #${id} (${result.tileCount} tiles, ${result.sizeMB} MB)`);
          send({
            phase: "done_district", district: "all", id,
            tileCount: result.tileCount, sizeMB: result.sizeMB, elapsed: result.elapsed.toFixed(1)
          });
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

// ── Download specific districts (pooled workers) ──

export function createDownloadStream(keys: string[], geojson: boolean, token: string | null = null): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (data: Record<string, unknown>) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { }
      };

      const commonPayload = getCommonPayload(geojson);

      // ── Fixed-size worker pool ──
      // Process districts through a pool of MAX_POOL_SIZE concurrent workers.
      // This prevents OOM from spawning 22 workers simultaneously.
      const queue = [...keys];
      const running: Promise<void>[] = [];

      async function processNext(): Promise<void> {
        while (queue.length > 0) {
          if (token && cancelledTokens.has(token)) break;

          const key = queue.shift()!;
          log("INFO", `Download started: ${key}`);

          try {
            const result = await runWorkerJob(
              "download.worker",
              { ...commonPayload, districtKey: key },
              send,
              token
            );

            if (result) {
              const id = registerMBTiles(result.mbtilesPath);
              log("INFO", `Download done: ${key} → #${id} (${result.tileCount} tiles, ${result.sizeMB} MB)`);
              send({
                phase: "done_district", district: key, id,
                tileCount: result.tileCount, sizeMB: result.sizeMB, elapsed: result.elapsed.toFixed(1)
              });
            }
          } catch (err: any) {
            log("ERROR", `Download failed: ${key}: ${err?.message}`);
            send({ phase: "error", message: `Failed: ${key}` });
          }
        }
      }

      // Launch up to MAX_POOL_SIZE parallel processors that pull from the queue
      const poolSize = Math.min(MAX_POOL_SIZE, keys.length);
      for (let i = 0; i < poolSize; i++) {
        running.push(processNext());
      }
      await Promise.all(running);

      // Clean up worker references for this token
      if (token) {
        activeWorkers.delete(token);
        cancelledTokens.delete(token);
      }

      send({ phase: "done", message: `Finished ${keys.length} district(s)` });
      controller.close();
    },
  });
}
