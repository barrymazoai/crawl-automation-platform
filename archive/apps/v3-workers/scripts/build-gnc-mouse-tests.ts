import { build } from "tsdown";
await build({ entry:{ "gnc-mouse-challenge.test":"src/gnc-mouse-challenge.test.ts", "browser.test":"../../packages/v3-acquisition/src/browser.test.ts",
  "lane-session.test":"../../packages/v3-acquisition/src/lane-session.test.ts" },
  outDir:"dist/gnc-mouse-tests",config:false,format:"esm",noExternal:[/^@crawl-automation\/v3-/],external:["vitest","zod",/^@temporalio\//,"pg","@aws-sdk/client-s3"] });
