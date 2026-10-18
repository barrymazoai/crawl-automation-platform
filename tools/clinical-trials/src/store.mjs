// <data-dir>/studies/<NCT0123>/<nct>.json.gz holds the latest API record of every kept study;
// <data-dir>/index.jsonl one bookkeeping line per study; <data-dir>/state.json the watermark and
// what the previous runs saw. Files are written atomically; a study file only when its content changed.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { gunzipSync, gzipSync } from 'node:zlib';
import stringify from 'safe-stable-stringify';

export const contentHash = (study) => `sha256:${createHash('sha256').update(stringify(study)).digest('hex')}`;

const studyFile = (dataDir, nct) => join(dataDir, 'studies', nct.slice(0, 7), `${nct}.json.gz`);

export async function readStudy(dataDir, nct) {
  return JSON.parse(gunzipSync(await readFile(studyFile(dataDir, nct))).toString('utf8'));
}

export async function writeStudy(dataDir, nct, study) {
  const file = studyFile(dataDir, nct);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, gzipSync(JSON.stringify(study)));
  await rename(`${file}.tmp`, file);
}

export async function loadIndex(dataDir) {
  const index = new Map();
  try {
    const lines = createInterface({ input: createReadStream(join(dataDir, 'index.jsonl')), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      index.set(entry.nct_id, entry);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return index;
}

export async function writeIndex(dataDir, index) {
  const body = [...index.values()]
    .sort((a, b) => a.nct_id.localeCompare(b.nct_id))
    .map((e) => JSON.stringify(e))
    .join('\n');
  await writeText(join(dataDir, 'index.jsonl'), body ? `${body}\n` : '');
}

export async function readState(dataDir) {
  try {
    return JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export const writeState = (dataDir, state) => writeJson(join(dataDir, 'state.json'), state);

export async function writeJson(file, value) {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeJsonl(file, rows) {
  await writeText(file, rows.length ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : '');
}

async function writeText(file, text) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}
