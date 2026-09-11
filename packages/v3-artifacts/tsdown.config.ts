import { defineConfig } from "tsdown";
export default defineConfig({
  entry: ["src/index.ts"], format: "esm", dts: true,
  // Inline runtime TS, but keep declarations referencing the shared type package.
  noExternal: (id, importer) => id === "@crawl-automation/v3-contracts" && !/\.d\.[cm]?ts$/.test(importer ?? ""),
});
