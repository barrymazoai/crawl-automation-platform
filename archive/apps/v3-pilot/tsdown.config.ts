import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/runners/worker.ts", "src/runners/submit.ts"],
  format: "esm",
  // Private workspace exports TS source in dev; plain Node deployments need it inlined.
  noExternal: ["@crawl-automation/v3-contracts"],
});
