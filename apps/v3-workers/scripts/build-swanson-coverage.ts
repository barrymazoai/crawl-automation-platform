import {build} from "tsdown";
import {bundleWorkflowCode} from "@temporalio/worker";
import {writeFile,cp} from "node:fs/promises";
import {resolve} from "node:path";
const common={config:false as const,format:"esm" as const,noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,"zod","pg","vitest","@aws-sdk/client-s3"]};
await build({...common,entry:{"swanson-live-worker":"src/swanson-live-worker.ts","product-workflow-worker":"src/product-workflow-worker.ts"},outDir:"dist/swanson-coverage"});
const bundle=(await bundleWorkflowCode({workflowsPath:resolve("src/product-workflows.ts")})).code;
await writeFile("dist/swanson-coverage/product-workflows.cjs",bundle);
await build({...common,entry:{
 "swanson-family.test":"../../packages/v3-channels/src/swanson-family.test.ts",
 "swanson-ego.test":"../../packages/v3-channels/src/swanson-ego.test.ts",
 "swanson-catalog-rendered.test":"../../packages/v3-channels/src/swanson-catalog-rendered.test.ts",
 "swanson-live.test":"../../packages/v3-channels/src/swanson-live.test.ts",
 "swanson-catalog-workflow.test":"../../packages/v3-product/src/swanson-catalog-workflow.test.ts",
 "catalog-workflow.test":"../../packages/v3-product/src/catalog-workflow.test.ts",
 "channel-stream.test":"integration/channel-stream.test.ts",
 "swanson-family-integration.test":"integration/swanson-family.test.ts",
 "swanson-catalog-ledger.test":"integration/swanson-catalog-ledger.test.ts",
},outDir:"dist/swanson-coverage-tests"});
await cp("dist/swanson-coverage/product-workflows.cjs","dist/swanson-coverage-tests/product-workflows.cjs");
await writeFile("dist/swanson-coverage-tests/family-proof-workflows.cjs",(await bundleWorkflowCode({workflowsPath:resolve("integration/swanson-family-proof-workflows.ts")})).code);
await cp("../../database/v3/013_catalog_presence.sql","dist/swanson-coverage-tests/013_catalog_presence.sql");
await build({...common,entry:{"mini-swanson-coverage":"scripts/mini-swanson-coverage.ts"},outDir:"dist/swanson-coverage-proof"});
await build({...common,entry:{"mini-swanson-coverage-label":"scripts/mini-swanson-coverage-label.ts"},outDir:"dist/swanson-coverage-label-proof"});
