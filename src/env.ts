import { resolve } from "path";
const e = process.env;

export const env = {
  PORT: parseInt(e.PORT || "3000", 10),
  CORS_ORIGINS: (e.CORS_ORIGIN || "http://localhost:5173").split(",").map(s => s.trim()),

  TILE_API_URL: e.TILE_API_URL || "https://bando.tphcm.gov.vn/service/gisp/tile/building",
  TILE_REFERER: e.TILE_REFERER || "https://bando.tphcm.gov.vn/",
  TILE_ORIGIN: e.TILE_ORIGIN || "https://bando.tphcm.gov.vn",

  OUTPUT_DIR: resolve(import.meta.dir, e.OUTPUT_DIR || "../output"),
  LOG_DIR: resolve(import.meta.dir, e.LOG_DIR || "../logs"),

  ZOOM: parseInt(e.ZOOM || "16", 10),
  TILE_OVERLAP: parseInt(e.TILE_OVERLAP || "3", 10),
  CONCURRENCY: parseInt(e.CONCURRENCY || "12", 10),
  RETRY_DELAY_MS: parseInt(e.RETRY_DELAY_MS || "2000", 10),

  LAYER_NAME: e.LAYER_NAME || "region_building3d_index",
} as const;

export const ENABLE_CLEANUP = (e.ENABLE_CLEANUP === "true") || (e.NODE_ENV === "production");
