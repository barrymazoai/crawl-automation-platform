import { build } from "tsdown";
// No browser/PDF service startup and no changes to the existing GNC release directory.
await build({ entry: ["src/channel-plan-worker.ts"], outDir: "dist/channel-plan", config: false, format: "esm",
  noExternal: [/^@crawl-automation\/v3-/], external: [/^@temporalio\//, "zod", "pg", "@aws-sdk/client-s3"] });
