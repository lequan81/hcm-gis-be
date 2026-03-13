import { resolve } from "path";

const e = process.env;

export const env = {
  PORT: parseInt(e.PORT || "3000", 10),
  CORS_ORIGINS: (e.CORS_ORIGIN || "http://localhost:5173").split(",").map(s => s.trim()),

  TILE_API_URL: e.TILE_API_URL || "https://bando.tphcm.gov.vn/service/gisp/tile/building",
  TILE_REFERER: e.TILE_REFERER || "https://bando.tphcm.gov.vn/",
  TILE_ORIGIN: e.TILE_ORIGIN || "https://bando.tphcm.gov.vn",

  // Use import.meta.dir to resolve relative to this file's location (src/config.ts)
  OUTPUT_DIR: resolve(import.meta.dir, e.OUTPUT_DIR || "../../output"),
  LOG_DIR: resolve(import.meta.dir, e.LOG_DIR || "../../logs"),

  ZOOM: parseInt(e.ZOOM || "16", 10),
  TILE_OVERLAP: parseInt(e.TILE_OVERLAP || "1", 10),
  CONCURRENCY: parseInt(e.CONCURRENCY || "12", 10),
  GLOBAL_TILE_CONCURRENCY: parseInt(e.GLOBAL_TILE_CONCURRENCY || "75", 10),
  WORKER_POOL_SIZE: parseInt(e.WORKER_POOL_SIZE || "3", 10),
  RETRY_DELAY_MS: parseInt(e.RETRY_DELAY_MS || "2000", 10),

  // Performance tuning
  TILE_SLEEP_MS: parseInt(e.TILE_SLEEP_MS || "10", 10),
  TILE_BATCH_SIZE: parseInt(e.TILE_BATCH_SIZE || "200", 10),

  LAYER_NAME: e.LAYER_NAME || "region_building3d_index",

  // Redis
  REDIS_ENABLED: e.REDIS_ENABLED === "true",
  REDIS_URL: e.REDIS_URL || "redis://localhost:6379",

  // Data retention
  MAX_FILE_AGE_HOURS: parseInt(e.MAX_FILE_AGE_HOURS || "24", 10),
} as const;

export const ENABLE_CLEANUP = (e.ENABLE_CLEANUP === "true") || (e.NODE_ENV === "production");
