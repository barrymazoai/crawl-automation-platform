import { build } from "tsdown";
await build({ config: false, entry: {
  "operator-ready-gate.test": "scripts/operator-ready-gate.test.ts",
  "lane-pool.test": "../../packages/v3-acquisition/src/lane-pool.test.ts",
  "lane-session.test": "../../packages/v3-acquisition/src/lane-session.test.ts",
  "browser-profile.test": "../../packages/v3-acquisition/src/browser-profile.test.ts",
  "runtime.test": "../../packages/v3-worker-runtime/src/runtime.test.ts",
  "mini-lane-session-smoke": "scripts/mini-lane-session-smoke.ts",
  "lane-health-worker": "scripts/lane-health-worker.ts",
  "lane-crash-fixture": "scripts/lane-crash-fixture.ts",
  "lane-crash.test": "integration/lane-crash.test.ts",
  "clash-lanes.test": "../../packages/v3-acquisition/src/clash-lanes.test.ts",
  "lane-api": "../../packages/v3-acquisition/src/index.ts",
  "gnc-lane-binding": "src/gnc-lane-binding.ts",
  "gnc-lane-binding.test": "src/gnc-lane-binding.test.ts",
}, outDir: "dist/lane-pool", format: "esm", noExternal: [/^@crawl-automation\/v3-/],
external: ["vitest", "zod", "@aws-sdk/client-s3", "pg"] });
