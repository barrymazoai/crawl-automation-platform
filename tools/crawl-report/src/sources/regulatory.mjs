// Regulatory rounds (tools/regulatory, Tue/Fri on Server 一): one report per sync that pushed, from
// <data>/sync/runs/<run>/ (the batches sent and Supply Smart's answers) and <data>/runs/*/manifest.json
// (the crawls). The report's runId is the pushed run, the run id the regulatory.ingest batches carried. The latest sync's last-sync.json adds its start/end and reports a sync that failed.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const exists = (file) => stat(file).then(() => true, () => false);

export async function regulatoryReports({ dataDir, crawler, log }) {
  const syncRuns = join(dataDir, 'sync', 'runs');
  const last = (await exists(join(dataDir, 'last-sync.json'))) ? await readJson(join(dataDir, 'last-sync.json')) : null;
  const reports = [];
  const crawls = await crawlManifests(dataDir);
  for (const runId of (await readdir(syncRuns)).sort()) {
    const pushedRun = crawls.find((m) => m.run_id === runId);
    if (!pushedRun) {
      log.warn({ runId }, 'regulatory sync run without a crawl manifest, skipped');
      continue;
    }
    const plan = await readJson(join(syncRuns, runId, 'plan.json'));
    const syncStart = [plan.created_at, pushedRun.started_at].sort()[0];
    // A sync may push an offline re-run of its crawl (e.g. after the model read new letters); the pages were
    // fetched by the latest online run of the same sync.
    const manifest = pushedRun.offline
      ? (crawls.filter((m) => !m.offline && m.started_at >= syncStart && m.started_at <= pushedRun.started_at).at(-1) ?? pushedRun)
      : pushedRun;
    const files = (await readdir(join(syncRuns, runId))).filter((name) => /^batch-\d+\.result\.json$/.test(name)).sort();
    const results = await Promise.all(files.map((name) => readJson(join(syncRuns, runId, name))));
    const real = results.filter((result) => !result.dryRun);
    if (!real.length) continue;
    const lastResultAt = (await stat(join(syncRuns, runId, files.at(-1)))).mtime.toISOString();
    const sync = last?.crawl?.run_id === runId ? last : null;
    reports.push(
      report({ runId, manifest, results: real, sync, startedAt: sync?.started_at ?? syncStart, finishedAt: sync?.finished_at ?? lastResultAt, crawler }),
    );
  }
  // A sync that stopped before pushing leaves no sync/runs entry; only the latest one is on record.
  if (last && !last.ok && !last.dry_run && !reports.some((r) => r.runId === (last.crawl?.run_id ?? last.sync_id))) {
    reports.push(failed(last, crawler));
  }
  return reports;
}

/** Every crawl's manifest (scheduled, manual and offline runs), oldest first. */
async function crawlManifests(dataDir) {
  const runs = join(dataDir, 'runs');
  const out = [];
  for (const name of (await readdir(runs)).sort()) {
    const file = join(runs, name, 'manifest.json');
    if (await exists(file)) out.push(await readJson(file));
  }
  return out.filter((m) => m.run_id && m.started_at).sort((a, b) => a.started_at.localeCompare(b.started_at));
}

function report({ runId, manifest, results, sync, startedAt, finishedAt, crawler }) {
  const sources = Object.entries(manifest.sources ?? {});
  const notOk = sources.filter(([, s]) => s.status !== 'ok').map(([name]) => name);
  const requests = (pick) => sources.reduce((n, [, s]) => n + (s.requests?.[pick] ?? 0), 0);
  const counts = (pick) => results.reduce((n, r) => n + (r.counts?.[pick] ?? 0), 0);
  const problems = sync?.problems ?? [];
  const status = notOk.length || problems.length ? 'partial' : 'completed';
  return {
    source: 'regulatory',
    runId,
    server: 'server-1',
    crawler,
    // Tuesday and Friday (crontab on Server 一).
    schedule: { everyDays: 3.5 },
    startedAt,
    finishedAt,
    status,
    // Warning letters, GRAS and NDI are read in full every run; Prop 65 reads its last 12 months.
    scope: 'full',
    counts: {
      targets: requests('total'),
      fetched: requests('ok'),
      failed: requests('failed') + requests('blocked'),
      pushed: counts('received'),
    },
    breakdown: {
      ...Object.fromEntries(
        sources.map(([name, s]) => [
          name,
          { status: s.status, new: s.new ?? 0, updated: s.updated ?? 0, removed: s.removed ?? 0, total: s.total_in_file ?? s.total ?? 0 },
        ]),
      ),
      supply_smart_push: {
        events: counts('events'),
        inserted: counts('inserted'),
        updated: counts('updated'),
        unchanged: counts('unchanged'),
        sync_run_ids: [...new Set(results.map((r) => r.syncRunId).filter(Boolean))],
      },
    },
    ...(status === 'partial'
      ? {
          error: {
            code: notOk.length ? 'source_not_ok' : 'sync_problems',
            message: [notOk.length ? `not ok: ${notOk.join(', ')}` : '', ...problems.map(String)].filter(Boolean).join('; ').slice(0, 500),
          },
        }
      : {}),
  };
}

function failed(last, crawler) {
  const pushed = last.push?.counted ? (last.push.counted.inserted ?? 0) + (last.push.counted.updated ?? 0) + (last.push.counted.unchanged ?? 0) : 0;
  return {
    source: 'regulatory',
    runId: last.crawl?.run_id ?? last.sync_id,
    server: 'server-1',
    crawler,
    // Tuesday and Friday (crontab on Server 一).
    schedule: { everyDays: 3.5 },
    startedAt: last.started_at,
    finishedAt: last.finished_at ?? last.started_at,
    status: 'failed',
    scope: 'full',
    counts: { targets: 0, fetched: 0, failed: 0, pushed },
    error: { code: 'sync_failed', message: (last.problems ?? []).map(String).join('; ').slice(0, 500) || 'sync did not finish' },
  };
}
