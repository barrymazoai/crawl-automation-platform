import { defineConfig } from "tsdown";
export default defineConfig({ entry: ["src/index.ts"], format: "esm", dts: true,
  // Node deployment must not try to execute workspace .ts exports without a loader.
  noExternal: (id, importer) => /^@crawl-automation\/v3-/.test(id) && !/\.d\.[cm]?ts$/.test(importer ?? ""),
});
