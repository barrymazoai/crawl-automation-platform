import { defineConfig } from "tsdown";

// One file per entry for production: workspace packages are bundled in; npm dependencies stay external.
export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  platform: "node",
  outDir: "dist",
  noExternal: [/^@crawl-automation\//],
  clean: true,
});
