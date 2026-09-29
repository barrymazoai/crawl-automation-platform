import { defineConfig } from "tsdown";

// One file per entry for production: workspace packages are bundled in; npm dependencies stay external.
// The workflow code is bundled separately by `src/bundle-workflows.ts` (Temporal's own bundler).
export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  platform: "node",
  outDir: "dist",
  noExternal: [/^@crawl-automation\//],
  clean: true,
});
