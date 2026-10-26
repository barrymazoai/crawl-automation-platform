// Files under <data-dir>/state, written atomically (temp file + rename) like the regulatory store.
//   registry.json        the branded ingredients and their match aliases (registry.mjs)
//   verdicts.jsonl       one judgement per ®/™ spelling, keyed by key(spelling) (verdicts.mjs)
//   map.json             ingredient id → branded ingredient external keys, as last reported
//   seen-names.json.gz   Supply Smart ingredient ids whose spellings were already looked at
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { gunzipSync, gzipSync } from 'node:zlib';

export { readJson, writeJson } from '../../../regulatory/src/lib/store.mjs';

export const statePath = (dataDir, name) => join(dataDir, 'state', name);

async function atomic(file, body) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, body);
  await rename(`${file}.tmp`, file);
}

export async function readJsonl(file) {
  const rows = [];
  try {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return rows;
}

export const writeJsonl = (file, rows) => atomic(file, rows.length ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : '');

export async function readJsonGz(file) {
  try {
    return JSON.parse(gunzipSync(await readFile(file)).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export const writeJsonGz = (file, value) => atomic(file, gzipSync(JSON.stringify(value)));
