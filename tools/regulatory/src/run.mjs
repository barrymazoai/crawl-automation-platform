// node src/run.mjs --data-dir <dir> --mode backfill|incremental [--sources a,b] [--refetch-pages] [--offline]
//
// Writes <dir>/<kind>.jsonl (current state of every record), <dir>/manifest.json
// (this run) and <dir>/runs/<run-id>/ (log, manifest, new/changed records).
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pino from 'pino';
import lockfile from 'proper-lockfile';
import { createHttp } from './lib/http.mjs';
import { completeness, dateRange, loadKind, readJson, upsert, writeJson, writeJsonl } from './lib/store.mjs';
import gras from './sources/gras.mjs';
import mediaRss from './sources/media-rss.mjs';
import ndi from './sources/ndi.mjs';
import prop65 from './sources/prop65.mjs';
import warningLetters from './sources/warning-letters.mjs';

const SOURCES = [warningLetters, gras, ndi, prop65, mediaRss];
const KINDS = ['warning_letter', 'gras', 'ndi', 'lawsuit'];

const { values: args } = parseArgs({
  options: {
    'data-dir': { type: 'string', default: process.env.REGULATORY_DATA_DIR },
    mode: { type: 'string', default: 'incremental' },
    sources: { type: 'string' },
    'refetch-pages': { type: 'boolean', default: false },
    offline: { type: 'boolean', default: false },
  },
});
if (!args['data-dir']) throw new Error('--data-dir (or REGULATORY_DATA_DIR) is required');
if (!['backfill', 'incremental'].includes(args.mode)) throw new Error('--mode must be backfill or incremental');
const selected = args.sources ? args.sources.split(',').map((s) => s.trim()) : SOURCES.map((s) => s.name);
const unknown = selected.filter((name) => !SOURCES.some((s) => s.name === name));
if (unknown.length) throw new Error(`unknown sources: ${unknown.join(', ')}`);

const dataDir = resolve(args['data-dir']);
const now = new Date().toISOString();
const runId = now.replace(/[:.]/g, '-');
const runDir = join(dataDir, 'runs', runId);
await mkdir(runDir, { recursive: true });

const log = pino(
  { base: { run: runId }, timestamp: pino.stdTimeFunctions.isoTime },
  pino.multistream([{ stream: process.stdout }, { stream: pino.destination({ dest: join(runDir, 'run.log'), sync: true }) }]),
);

const release = await lockfile.lock(dataDir, { lockfilePath: join(dataDir, '.run.lock'), stale: 6 * 60 * 60 * 1000, update: 60 * 1000 });
try {
  const http = createHttp({
    cacheDir: join(dataDir, 'cache'),
    log,
    userAgent: process.env.REGULATORY_USER_AGENT ?? 'Mozilla/5.0 (compatible; regulatory-collector/0.1; public records)',
    intervalMs: Number(process.env.REGULATORY_INTERVAL_MS ?? 1000),
    retries: 3,
    timeoutMs: 60_000,
    maxConsecutiveBlocks: 3,
    offline: args.offline,
  });

  const stores = new Map();
  for (const kind of KINDS) stores.set(kind, await loadKind(join(dataDir, `${kind}.jsonl`)));

  log.info({ mode: args.mode, sources: selected, refetchPages: args['refetch-pages'], offline: args.offline }, 'run started');
  const active = SOURCES.filter((s) => selected.includes(s.name));
  const results = await Promise.allSettled(
    active.map(async (source) => {
      const client = http.forSource();
      const started = Date.now();
      const sourceLog = log.child({ source: source.name });
      try {
        const out = await source.collect({
          http: client,
          log: sourceLog,
          mode: args.mode,
          now,
          refetchPages: args['refetch-pages'],
          previous: stores.get(source.kind),
        });
        sourceLog.info({ records: out.records.length, seconds: Math.round((Date.now() - started) / 1000) }, 'source collected');
        return { source, out, requests: client.requests };
      } catch (error) {
        sourceLog.error({ err: error.message }, 'source failed');
        throw Object.assign(error, { source, requests: client.requests });
      }
    }),
  );

  const manifest = {
    run_id: runId,
    mode: args.mode,
    refetch_pages: args['refetch-pages'],
    offline: args.offline,
    started_at: now,
    finished_at: null,
    data_dir: dataDir,
    sources: {},
    kinds: {},
  };
  const changes = new Map(KINDS.map((k) => [k, []]));
  for (const result of results) {
    const { source, requests } = result.status === 'fulfilled' ? result.value : result.reason;
    const entry = {
      kind: source.kind,
      status: 'ok',
      requests: summarize(requests),
    };
    if (result.status === 'rejected') {
      entry.status = result.reason.name === 'HostBlockedError' ? 'blocked' : 'failed';
      entry.error = result.reason.message;
    } else {
      const { records, listedKeys, stats, failures, notes } = result.value.out;
      const store = stores.get(source.kind);
      const counts = { new: 0, updated: 0, unchanged: 0, removed: 0 };
      for (const record of records) {
        const outcome = upsert(store, record, { now, inventory: source.inventory });
        counts[outcome] += 1;
        if (outcome !== 'unchanged') changes.get(source.kind).push(store.get(`${record.source}|${record.source_key}`));
      }
      const owns = (r) => r.source === source.name || r.source.startsWith(`${source.name}:`);
      // Full reconcile of a complete list: a record whose key is gone from the
      // source gets removed_at (it is kept, never deleted).
      if (args.mode === 'backfill' && source.completeList && listedKeys?.size) {
        for (const r of store.values()) {
          if (!owns(r) || r.removed_at || listedKeys.has(r.source_key)) continue;
          r.removed_at = now;
          counts.removed += 1;
          changes.get(source.kind).push(r);
        }
      }
      const own = [...store.values()].filter(owns);
      Object.assign(entry, {
        collected: records.length,
        ...counts,
        total_in_file: own.length,
        not_seen_this_run: own.filter((r) => r.last_seen_at !== now).length,
        event_date: dateRange(own, 'event_date'),
        published_date: dateRange(own, 'published_date'),
        stats,
        failures,
        notes: notes ?? [],
        completeness: completeness(own),
      });
      if (failures.length) entry.status = 'ok_with_failures';
    }
    manifest.sources[source.name] = entry;
  }

  for (const kind of KINDS) {
    const records = [...stores.get(kind).values()];
    await writeJsonl(join(dataDir, `${kind}.jsonl`), records);
    if (changes.get(kind).length) await writeJsonl(join(runDir, 'changes', `${kind}.jsonl`), changes.get(kind));
    manifest.kinds[kind] = {
      file: `${kind}.jsonl`,
      count: records.length,
      changed_this_run: changes.get(kind).length,
      event_date: dateRange(records, 'event_date'),
      completeness: completeness(records),
    };
  }
  manifest.finished_at = new Date().toISOString();
  for (const entry of Object.values(manifest.sources)) entry.run_id = runId;
  await writeJson(join(runDir, 'manifest.json'), manifest);
  // The top-level manifest describes the files as they stand: a source this run
  // did not touch keeps its entry from the run that last collected it.
  const previous = await readJson(join(dataDir, 'manifest.json'));
  const current = { ...manifest, sources: { ...manifest.sources } };
  for (const [name, entry] of Object.entries(previous?.sources ?? {})) {
    if (!(name in current.sources)) current.sources[name] = { run_id: previous.run_id, ...entry };
  }
  await writeJson(join(dataDir, 'manifest.json'), current);
  log.info(
    { sources: Object.fromEntries(Object.entries(manifest.sources).map(([k, v]) => [k, v.status])) },
    'run finished',
  );
} finally {
  await release();
}

function summarize(requests) {
  const by = (o) => requests.filter((r) => r.outcome === o);
  return {
    total: requests.length,
    ok: by('ok').length,
    failed: by('failed').length,
    blocked: by('blocked').length,
    retried: requests.filter((r) => r.attempts > 1).length,
    problems: requests
      .filter((r) => r.outcome !== 'ok')
      .map(({ url, status, outcome, error, attempts }) => ({ url, status, outcome, error, attempts })),
  };
}
