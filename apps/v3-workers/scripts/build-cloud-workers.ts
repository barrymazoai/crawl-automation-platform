// Release for ledger-less ("cloud mode") Workers on the two Windows machines: ocr / text / vision roles of the
// channel-label Worker, plus the package.json the destination needs for `npm install --omit=dev`.
// Native Temporal dependencies are installed on the destination, never copied from macOS.
import { build } from 'tsdown';
import { writeFile, cp, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const out = 'dist/cloud-workers', common = { config: false as const, format: 'esm' as const, noExternal: [/^@crawl-automation\/v3-/, 'linkedom'], external: [/^@temporalio\//, 'zod', 'pg', '@aws-sdk/client-s3'] };
await build({ ...common, outDir: out, entry: ['src/channel-label-worker.ts'] });
// The cloud entry must never import a PostgreSQL client path at module load; the ledger is optional at runtime, not absent at build.
const require = createRequire(import.meta.url);
const installed = (name: string) => JSON.parse(require('node:fs').readFileSync(require.resolve(name + '/package.json'), 'utf8')).version as string;
await writeFile(out + '/package.json', JSON.stringify({ name: 'crawlv3-cloud-workers', version: '0.1.0', private: true, type: 'module', engines: { node: '>=22.16 <25' },
  dependencies: Object.fromEntries(['@temporalio/worker', '@temporalio/client', '@temporalio/activity', '@temporalio/common', '@temporalio/workflow', 'pg', 'zod', '@aws-sdk/client-s3'].map(n => [n, installed(n)])) }, null, 2) + '\n');
await cp('CLOUD_WORKERS.md', out + '/README.md');
const hash = createHash('sha256');
for (const n of (await readdir(out)).filter(n => n.endsWith('.js')).sort()) { const b = await readFile(out + '/' + n); hash.update(String(b.length) + ':').update(b); }
await writeFile(out + '/BUILD_ID', hash.digest('hex') + '\n');
console.log('built', out, 'buildId', (await readFile(out + '/BUILD_ID', 'utf8')).trim());
