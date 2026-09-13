import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'tsdown';
import {bundleWorkflowCode} from '@temporalio/worker';

// Separate bundle leaves all existing product/Windows workflow identities unchanged.
await build({entry:['src/amazon-batch-worker.ts'],outDir:'dist/amazon-batch',config:false,format:'esm',noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,'zod','pg','@aws-sdk/client-s3']});
const bundle=await bundleWorkflowCode({workflowsPath:resolve('src/amazon-batch-workflow.ts')});
await writeFile('dist/amazon-batch/amazon-batch-workflows.cjs',bundle.code);
