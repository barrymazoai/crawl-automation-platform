import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'tsdown';
import { bundleWorkflowCode } from '@temporalio/worker';

await build({ entry: { worker: 'src/brand-entry/worker.ts', cli: 'src/brand-entry/cli.ts', 'browser-script': 'src/brand-entry/browser-script.ts' },
  outDir: 'dist/brand-entry', config: false, format: 'esm', noExternal: [/^@crawl-automation\/v3-/],
  external: [/^@temporalio\//, 'zod', 'pg', '@aws-sdk/client-s3'] });
const bundle = await bundleWorkflowCode({ workflowsPath: resolve('src/brand-entry/workflow.ts') });
await writeFile('dist/brand-entry/workflows.cjs', bundle.code);
