// One JSONL file per kind holds the current state of every record ever seen,
// keyed by source + source_key. A run merges what it collected and writes the
// whole file atomically; new/changed records also go to the run's changes file.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import stringify from 'safe-stable-stringify';

// Fields a source supplies; their hash detects a change. Bookkeeping fields
// (fetched_at, first/last seen, the hash itself) are excluded.
const CONTENT_FIELDS = [
  'kind',
  'source',
  'source_key',
  'source_url',
  'title',
  'summary',
  'raw_company_name',
  'raw_company_address',
  'raw_company_website',
  'event_date',
  'published_date',
  'status',
  'status_date',
  'details',
  'raw',
];

export const recordKey = (r) => `${r.source}|${r.source_key}`;

export function contentHash(record) {
  const content = Object.fromEntries(CONTENT_FIELDS.map((f) => [f, record[f] ?? null]));
  return `sha256:${createHash('sha256').update(stringify(content)).digest('hex')}`;
}

export async function loadKind(file) {
  const records = new Map();
  try {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      records.set(recordKey(r), r);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return records;
}

// `inventory` sources have no publication date of their own: published_date is
// the date the record was first seen and never moves afterwards.
export function upsert(records, incoming, { now, inventory }) {
  const key = recordKey(incoming);
  const previous = records.get(key);
  const record = {
    ...incoming,
    published_date: inventory ? (previous?.published_date ?? now.slice(0, 10)) : incoming.published_date,
  };
  record.content_hash = contentHash(record);
  record.first_seen_at = previous?.first_seen_at ?? now;
  record.last_seen_at = now;
  record.fetched_at = incoming.fetched_at ?? now;
  if (previous && previous.content_hash === record.content_hash) {
    records.set(key, { ...record, fetched_at: previous.fetched_at, changed_at: previous.changed_at });
    return 'unchanged';
  }
  record.changed_at = now;
  records.set(key, record);
  return previous ? 'updated' : 'new';
}

export async function writeJsonl(file, records) {
  await mkdir(dirname(file), { recursive: true });
  const sorted = [...records].sort((a, b) => recordKey(a).localeCompare(recordKey(b)));
  const body = sorted.map((r) => JSON.stringify(orderFields(r))).join('\n');
  await writeFile(`${file}.tmp`, body ? `${body}\n` : '');
  await rename(`${file}.tmp`, file);
}

export async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

const FIELD_ORDER = [...CONTENT_FIELDS.slice(0, 13), 'fetched_at', 'first_seen_at', 'last_seen_at', 'changed_at', 'content_hash', 'details', 'raw'];

function orderFields(r) {
  const out = {};
  for (const f of FIELD_ORDER) if (f in r) out[f] = r[f];
  for (const f of Object.keys(r)) if (!(f in out)) out[f] = r[f];
  return out;
}

const filled = (v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);

// Share of records with a non-empty value, per top-level field and per details field.
export function completeness(records) {
  const list = [...records];
  if (list.length === 0) return {};
  const fields = new Set();
  for (const r of list) {
    for (const f of CONTENT_FIELDS) if (f !== 'details' && f !== 'raw') fields.add(f);
    for (const f of Object.keys(r.details ?? {})) fields.add(`details.${f}`);
  }
  const out = {};
  for (const f of [...fields].sort()) {
    const n = list.filter((r) => filled(f.startsWith('details.') ? r.details?.[f.slice(8)] : r[f])).length;
    out[f] = Math.round((n / list.length) * 1000) / 10;
  }
  return out;
}

export function dateRange(records, field) {
  const values = [...records].map((r) => r[field]).filter(Boolean).sort();
  return values.length ? { min: values[0], max: values.at(-1) } : null;
}
