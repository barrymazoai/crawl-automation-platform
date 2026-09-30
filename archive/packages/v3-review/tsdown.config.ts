import { defineConfig } from "tsdown";
export default defineConfig({ entry: ["src/index.ts"], format: "esm", dts: true,
  noExternal: (id, importer) => id === "@crawl-automation/v3-contracts" && !/\.d\.[cm]?ts$/.test(importer ?? "") });
