import { defineConfig } from "tsdown";
export default defineConfig({ entry: ["src/index.ts", "src/workflow.ts"], format: "esm", dts: true,
  external: [/^@temporalio\//, /^@crawl-automation\//, "zod"] });
