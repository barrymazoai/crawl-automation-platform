import { defineConfig } from "tsdown";

// One file per entry for production: workspace packages are bundled in; npm dependencies stay external.
// parse-worker.js (KAN-243 2026-11-12) is the label copy parse thread, loaded beside main.js.
// The workflow code is bundled separately by `src/bundle-workflows.ts` (Temporal's own bundler).
export default defineConfig({
  entry: { main: "src/main.ts", "parse-worker": "src/label/parse-worker.ts" },
  format: "esm",
  platform: "node",
  outDir: "dist",
  noExternal: [/^@crawl-automation\//],
  clean: true,
});
