import { build } from "tsdown";
await build({ config: false, format: "esm", entry: ["scripts/mini-swanson-browser-proof.ts","scripts/mini-browser-permit-recovery.ts","scripts/mini-swanson-catalog-inspect.ts"], outDir: "dist/swanson-browser-proof",
  noExternal: [/^@crawl-automation\/v3-/], external: ["zod", "pg", "@aws-sdk/client-s3", /^@temporalio\//] });
