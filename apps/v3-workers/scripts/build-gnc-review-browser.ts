import { build } from "tsdown";
await build({entry:{"mini-gnc-review-browser":"scripts/mini-gnc-review-browser.ts"},outDir:"dist/gnc-review-browser",config:false,
  format:"esm",noExternal:[/^@crawl-automation\/v3-/],external:["zod",/^@temporalio\//,"pg","@aws-sdk/client-s3"]});
