import { build } from "tsdown";
import { bundleWorkflowCode } from "@temporalio/worker";
import { writeFile, mkdir, copyFile } from "node:fs/promises";
import {migrationNames} from "../../v3-api/src/bootstrap/schema.js";
import { fileURLToPath } from "node:url";
await build({entry:["scripts/mini-channel-label-proof.ts","scripts/mini-source-quality-proof.ts","scripts/verify-quality-batch.ts","scripts/mini-text-fallback-proof.ts","scripts/mini-visual-quality-proof.ts","scripts/mini-visual-review-release.ts","scripts/mini-visual-schema-clone.ts","scripts/verify-visual-quality.ts"],outDir:"dist/channel-label-proof",config:false,format:"esm",
  noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,"zod","pg","@aws-sdk/client-s3"]});
const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL("../integration/channel-label-workflows.ts",import.meta.url))});
await writeFile(new URL("../dist/channel-label-proof/channel-label-workflows.cjs",import.meta.url),bundle.code);
await mkdir(new URL("../dist/quality-migrations/",import.meta.url),{recursive:true});
for(const name of migrationNames)await copyFile(new URL(`../../../database/v3/${name}`,import.meta.url),new URL(`../dist/quality-migrations/${name}`,import.meta.url));
