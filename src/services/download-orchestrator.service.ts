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
import type { WorkerInput, WorkerAllInput, ProgressInfo, DownloadOutput, SseMessage } from "../types/worker";

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
  payload: (WorkerInput | WorkerAllInput) & { LOG_DIR?: string; LOG_FILE?: string },
  onProgress: (data: ProgressInfo) => void,
  token: string | null
): Promise<DownloadOutput | null> {
  return new Promise((resolve) => {
    const worker = new Worker(getWorkerUrl(workerFile));

    // If token was already cancelled before we even started, signal immediately
    if (token && cancelledTokens.has(token)) {
      worker.postMessage({ type: "cancel" });
    }

    worker.onmessage = (e: MessageEvent<{ type: "progress"; data: ProgressInfo } | { type: "result"; data: DownloadOutput | null }>) => {
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
  let isCancelled = false;
  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let lastSendTime = Date.now();
      const keepAliveIntervalMs = 15000; // Send keep-alive every 15s (more aggressive)

      // Aggressive keep-alive timer to prevent HTTP/2 connection drops
      const keepAliveTimer = setInterval(() => {
        if (!isCancelled) {
          const timeSinceLastSend = Date.now() - lastSendTime;
          if (timeSinceLastSend > 12000) { // >12s without data
            try {
              controller.enqueue(enc.encode(": KEEPALIVE\n\n")); // SSE comment
              lastSendTime = Date.now();
              log("DEBUG", `SSE keep-alive sent (${timeSinceLastSend}ms since last)`);
            } catch (e) {
              log("ERROR", `Keep-alive failed (all): ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      }, 5000); // Check every 5s

      const send = (data: SseMessage) => {
        if (isCancelled) return;
        try {
          const json = JSON.stringify(data);
          controller.enqueue(enc.encode(`data: ${json}\n\n`));
          lastSendTime = Date.now();
        } catch (e) {
          log("ERROR", `SSE send failed (all): ${e instanceof Error ? e.message : String(e)}`);
          clearInterval(keepAliveTimer);
          isCancelled = true;
          try { controller.close(); } catch { }
        }
      };

      // ── Send immediate ready message (prevents HTTP/2 timeout) ──
      try {
        send({ phase: "ready", message: "Downloading all HCM districts...", timestamp: new Date().toISOString() });
      } catch (e) {
        log("ERROR", `Failed to send ready (all): ${e instanceof Error ? e.message : String(e)}`);
        clearInterval(keepAliveTimer);
        controller.close();
        return;
      }

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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("ERROR", `Download ALL failed: ${message}`);
        send({ phase: "error", message: "Download ALL failed" });
      }

      clearInterval(keepAliveTimer);

      try {
        send({ phase: "done", message: "Finished downloading all HCM tiles", timestamp: new Date().toISOString() });
      } catch (e) {
        log("ERROR", `Failed to send done (all): ${e instanceof Error ? e.message : String(e)}`);
      }

      try { controller.close(); } catch { }
    },
    cancel() {
      isCancelled = true;
      if (token) cancelWorkers(token);
    }
  });
}

// ── Download specific districts (pooled workers) ──

export function createDownloadStream(keys: string[], geojson: boolean, token: string | null = null): ReadableStream {
  let isCancelled = false;
  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let lastSendTime = Date.now();
      const keepAliveIntervalMs = 15000; // Send keep-alive every 15s (more aggressive)

      // Aggressive keep-alive timer to prevent HTTP/2 connection drops
      const keepAliveTimer = setInterval(() => {
        if (!isCancelled) {
          const timeSinceLastSend = Date.now() - lastSendTime;
          if (timeSinceLastSend > 12000) { // >12s without data
            try {
              controller.enqueue(enc.encode(": KEEPALIVE\n\n")); // SSE comment
              lastSendTime = Date.now();
              log("DEBUG", `SSE keep-alive sent (${timeSinceLastSend}ms since last)`);
            } catch (e) {
              log("ERROR", `Keep-alive failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      }, 5000); // Check every 5s

      const send = (data: SseMessage) => {
        if (isCancelled) return;
        try {
          const json = JSON.stringify(data);
          controller.enqueue(enc.encode(`data: ${json}\n\n`));
          lastSendTime = Date.now();
        } catch (e) {
          log("ERROR", `SSE send failed: ${e instanceof Error ? e.message : String(e)}`);
          clearInterval(keepAliveTimer);
          isCancelled = true;
          try { controller.close(); } catch { }
        }
      };

      const commonPayload = getCommonPayload(geojson);

      // ── Send immediate ready message (prevents HTTP/2 timeout) ──
      try {
        send({ phase: "ready", message: `Processing ${keys.length} district(s)`, timestamp: new Date().toISOString() });
      } catch (e) {
        log("ERROR", `Failed to send ready: ${e instanceof Error ? e.message : String(e)}`);
        clearInterval(keepAliveTimer);
        controller.close();
        return;
      }

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
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log("ERROR", `Download failed: ${key}: ${message}`);
            send({ phase: "error", message: `Failed: ${key}` });
          }
        }
      }

      // Launch up to MAX_POOL_SIZE parallel processors that pull from the queue
      const poolSize = Math.min(MAX_POOL_SIZE, keys.length);
      for (let i = 0; i < poolSize; i++) {
        running.push(processNext());
      }

      try {
        await Promise.all(running);
      } catch (err) {
        log("ERROR", `Stream processing error: ${err instanceof Error ? err.message : String(err)}`);
      }

      clearInterval(keepAliveTimer);

      // Clean up worker references for this token
      if (token) {
        activeWorkers.delete(token);
        cancelledTokens.delete(token);
      }

      try {
        send({ phase: "done", message: `Finished ${keys.length} district(s)`, timestamp: new Date().toISOString() });
      } catch (e) {
        log("ERROR", `Failed to send done: ${e instanceof Error ? e.message : String(e)}`);
      }

      try { controller.close(); } catch { }
    },
    cancel() {
      isCancelled = true;
      if (token) cancelWorkers(token);
    }
  });
}
