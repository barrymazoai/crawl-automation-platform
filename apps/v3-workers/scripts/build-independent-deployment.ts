import {build} from "tsdown";
const common={config:false as const,format:"esm" as const,noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,"zod","pg","vitest","@aws-sdk/client-s3"]};
await build({...common,entry:{"deployment-launchd":"src/deployment-launchd.ts"},outDir:"dist/independent-deployment"});
await build({...common,entry:{"deployment-launchd.test":"src/deployment-launchd.test.ts"},outDir:"dist/independent-deployment-tests"});
