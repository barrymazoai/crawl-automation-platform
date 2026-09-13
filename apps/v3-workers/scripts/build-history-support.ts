import {build} from "tsdown";
import {cp} from "node:fs/promises";
const common={config:false as const,format:"esm" as const,noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,"zod","pg","vitest","@aws-sdk/client-s3"]};
// No workflow executable changes and no Windows browser role in this release.
await build({...common,entry:Object.fromEntries(["channel-plan-worker","channel-label-worker","swanson-live-worker","amazon-live-worker","gnc-worker","product-worker","brand-web","history-reconcile"].map(n=>[n,`src/${n}.ts`])),outDir:"dist/history-support"});
await cp("../../database/v3","dist/history-support/migrations",{recursive:true});
await build({...common,entry:{"history-observations.test":"integration/history-observations.test.ts","history-observations":"src/history-observations.ts",
 ...Object.fromEntries(['channel-plan','swanson-ego','amazon-ego','swanson-family','swanson-live','amazon-live','dtc-live'].map(n=>[`${n}.test`,`../../packages/v3-channels/src/${n}.test.ts`]))},outDir:"dist/history-support-tests"});
