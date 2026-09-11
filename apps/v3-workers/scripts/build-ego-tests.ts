import { build } from "tsdown";
await build({ entry: { "ego-browser.test": "../../packages/v3-acquisition/src/ego-browser.test.ts",
  "ego-file.test": "../../packages/v3-acquisition/src/ego-file.test.ts",
  "file.test": "../../packages/v3-acquisition/src/file.test.ts",
  "routes.test": "../../packages/v3-acquisition/src/routes.test.ts",
  "handoff.test": "../../packages/v3-acquisition/src/handoff.test.ts",
  "ego-port": "../../packages/v3-acquisition/src/ego-browser.ts",
  "gnc-browser.test": "../../packages/v3-channels/src/gnc-browser.test.ts" },
  outDir: "dist/ego-tests", config: false, format: "esm", noExternal: [/^@crawl-automation\/v3-/], external: ["vitest", "zod"] });
