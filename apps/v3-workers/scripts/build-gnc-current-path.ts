import {build} from "tsdown";
await build({entry:{"mini-gnc-current-path":"scripts/mini-gnc-current-path.ts"},outDir:"dist/gnc-current-path",config:false,format:"esm",
  noExternal:[/^@crawl-automation\/v3-/],external:["zod",/^@temporalio\//,"pg","@aws-sdk/client-s3"]});
