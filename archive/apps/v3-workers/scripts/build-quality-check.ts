import { build } from "tsdown";
await build({ entry: { "mini-gnc-quality-check": "scripts/mini-gnc-quality-check.ts" },
  outDir: "dist/quality-check", config: false, format: "esm", noExternal: [/^@crawl-automation\/v3-/], external: ["zod"] });
