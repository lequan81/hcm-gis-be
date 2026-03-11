/**
 * Worker input/output types for download workers.
 */

/** Payload sent to `download.worker.ts` */
export interface WorkerInput {
  districtKey: string;
  zoom: number;
  overlap: number;
  geojson: boolean;
  outputDir: string;
  concurrency: number;
  apiUrl: string;
  referer: string;
  origin: string;
  retryDelay: number;
  sleepMs: number;
  batchSize: number;
}

/** Payload sent to `download-all.worker.ts` (no districtKey) */
export interface WorkerAllInput {
  zoom: number;
  overlap: number;
  geojson: boolean;
  outputDir: string;
  concurrency: number;
  apiUrl: string;
  referer: string;
  origin: string;
  retryDelay: number;
  sleepMs: number;
  batchSize: number;
}

/** A single fetched tile result held in memory before writing to MBTiles. */
export interface TileResult {
  z: number;
  x: number;
  y: number;
  data: Uint8Array;
}

/** Output returned by workers after a successful download job. */
export interface DownloadOutput {
  mbtilesPath: string;
  tileCount: number;
  elapsed: number;
  sizeMB: string;
  featureCount?: number;
  geojsonPath?: string;
}
