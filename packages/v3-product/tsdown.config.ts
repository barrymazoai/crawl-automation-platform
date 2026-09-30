import { defineConfig } from "tsdown";
// Only the resource gate remains executable for pre-resource-gate-v1 workflow histories (R41).
export default defineConfig({
  entry: ["src/resource-workflow.ts"],
  format: "esm",
  dts: true,
  external: [/^@temporalio\//, /^@crawl-automation\//, "zod"],
});
