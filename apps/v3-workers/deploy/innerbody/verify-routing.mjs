import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const root = resolve(process.argv[2] || 'D:\\crawlv3-dtc-v2');
try {
  const mini = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'deployment.json'), 'utf8')).routing;
  const windows = JSON.parse(await readFile(join(root, 'private/routing.json'), 'utf8'));
  if (!isDeepStrictEqual(mini, windows)) throw Error('DTC_ROUTING_MISMATCH');
  console.log('DTC_MINI_WINDOWS_ROUTING_MATCHED');
} catch { console.error('DTC_ROUTING_MISMATCH_OR_MISSING'); process.exitCode = 1; }
