/**
 * Build script for hcm-gis-be
 * Compiles main.ts and workers cleanly to dist/
 */

import { build } from "bun";
import { rmSync, existsSync } from "fs";

if (existsSync("dist")) {
  rmSync("dist", { recursive: true, force: true });
}

console.log("🛠️ Building backend...");

const result = await build({
  entrypoints: [
    "src/main.ts",
    "src/workers/download.worker.ts",
    "src/workers/download-all.worker.ts"
  ],
  outdir: "dist",
  target: "bun",
  format: "esm",
  minify: true,
  sourcemap: "external"
});

if (!result.success) {
  console.error("❌ Build failed:");
  for (const message of result.logs) {
    console.error(message);
  }
  process.exit(1);
}

console.log(`✅ Build successful! Outputs in dist/ directory (${result.outputs.length} files).`);
