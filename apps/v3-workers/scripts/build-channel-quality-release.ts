import { build } from "tsdown";
await build({config:false,format:"esm",entry:["scripts/mini-channel-quality-release.ts"],outDir:"dist/channel-quality-release",
  noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,"zod","pg","@aws-sdk/client-s3"]});
