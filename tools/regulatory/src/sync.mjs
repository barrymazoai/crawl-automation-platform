// node src/sync.mjs --data-dir <dir> --supply-smart-env <file> [--webhook-file <file>]
//   [--skip-crawl] [--no-model] [--dry-run]
//
// The scheduled job (owner 2026-10-19: Tue and Fri 18:00 US Central, Server 一):
//   1. collect every source (src/run.mjs);
//   2. supplement-type warning letters without model ingredients are read by
//      Codex gpt-5.6-luna, effort medium, one at a time (src/ai-ingredients.mjs)
//      and merged (offline run);
//   3. records that are new or changed since the last successful push go to
//      Supply Smart `regulatory.ingest` in numbered batches of ≤ 500: every
//      batch as a dry run first, then for real;
//   4. Supply Smart's per-kind totals are compared with the files;
//   5. <dir>/last-sync.json is written and the 「Supply Smart 服务通知」 Feishu group gets a card
//      straight from this machine (owner 2026-10-19): a short summary, or the
//      problems in red.
// A problem in one step is reported; later steps still run when their input is
// sound (a failed source keeps its previous records, which are still correct).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execa } from 'execa';
import pino from 'pino';
import lockfile from 'proper-lockfile';
import { feishuNotifier } from '../../notify/feishu.mjs';
import { supplySmartFromEnvFile } from './lib/supply-smart.mjs';
import { loadKind, readJson, recordKey, writeJson } from './lib/store.mjs';
import { resultPath } from './sources/warning-letter-ai.mjs';

const KINDS = ['warning_letter', 'gras', 'ndi', 'lawsuit'];
const KIND_NAMES = { warning_letter: '警告信', gras: 'GRAS', ndi: 'NDI', lawsuit: '诉讼' };
const BATCH_SIZE = 500;
// Owner 2026-10-19: always this model and effort, passed explicitly; never the
// machine's Codex default and never a dearer model.
const MODEL = 'gpt-5.6-luna';
const EFFORT = 'medium';
const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
  options: {
    'data-dir': { type: 'string', default: process.env.REGULATORY_DATA_DIR },
    'supply-smart-env': { type: 'string' },
    'webhook-file': { type: 'string' },
    'skip-crawl': { type: 'boolean', default: false },
    'no-model': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (!args['data-dir']) throw new Error('--data-dir (or REGULATORY_DATA_DIR) is required');
if (!args['supply-smart-env']) throw new Error('--supply-smart-env <file> is required');
const dataDir = resolve(args['data-dir']);
const syncDir = join(dataDir, 'sync');
const startedAt = new Date().toISOString();
const syncId = startedAt.replace(/[:.]/g, '-');
await mkdir(join(syncDir, 'logs'), { recursive: true });
const log = pino(
  { base: { sync: syncId }, timestamp: pino.stdTimeFunctions.isoTime },
  pino.multistream([
    { stream: process.stdout },
    { stream: pino.destination({ dest: join(syncDir, 'logs', `${syncId}.log`), sync: true }) },
  ]),
);

const report = {
  sync_id: syncId,
  started_at: startedAt,
  finished_at: null,
  dry_run: args['dry-run'],
  ok: false,
  problems: [],
  crawl: null,
  model: null,
  push: null,
  cloud: null,
};
const problem = (text, detail) => {
  report.problems.push(text);
  log.error({ detail }, text);
};

// ── 1. Collect ──────────────────────────────────────────────────────────────

function node(script, scriptArgs) {
  return execa(process.execPath, [script, ...scriptArgs], { cwd: TOOL_DIR, all: true, reject: false });
}

const lastLine = (output) => output?.trim().split('\n').at(-1)?.slice(0, 300) ?? '';

async function crawl() {
  const result = await node('src/run.mjs', ['--data-dir', dataDir]);
  const manifest = await readJson(join(dataDir, 'manifest.json'));
  report.crawl = { exit_code: result.exitCode, run_id: manifest?.run_id ?? null, sources: {} };
  if (result.exitCode !== 0) {
    problem(`采集退出码 ${result.exitCode}：${lastLine(result.all)}`);
    return;
  }
  for (const [name, entry] of Object.entries(manifest.sources)) {
    if (entry.run_id !== manifest.run_id) continue;
    report.crawl.sources[name] = {
      status: entry.status,
      new: entry.new ?? 0,
      updated: entry.updated ?? 0,
      removed: entry.removed ?? 0,
      total: entry.total_in_file ?? null,
      requests: entry.requests?.total ?? 0,
      blocked: entry.requests?.blocked ?? 0,
      failed: entry.requests?.failed ?? 0,
    };
    if (entry.status !== 'ok') problem(`${name} 采集状态 ${entry.status}${entry.error ? `：${entry.error}` : ''}`);
    if (entry.removals_skipped) {
      const s = entry.removals_skipped;
      problem(`${name} 列表从 ${s.listed_before} 条降到 ${s.listed} 条（超过 5%），本次没有标记删除（本应标 ${s.would_remove} 条）`);
    }
  }
}

// ── 2. Ingredients of new supplement-type letters ───────────────────────────

const waitingForModel = (letters) =>
  [...letters.values()].filter(
    (r) => r.details?.scope === 'dietary_supplement' && !r.removed_at && !String(r.details.ingredients_source ?? '').startsWith('model:'),
  );

async function readIngredients() {
  const waiting = waitingForModel(await loadKind(join(dataDir, 'warning_letter.jsonl')));
  report.model = { model: MODEL, effort: EFFORT, letters: waiting.length, read: 0, still_waiting: waiting.length, tokens: 0 };
  if (!waiting.length) return;
  const slugsFile = join(syncDir, 'logs', `${syncId}-model-slugs.json`);
  await writeFile(slugsFile, JSON.stringify(waiting.map((r) => r.source_key)));
  const ai = await node('src/ai-ingredients.mjs', [
    '--data-dir', dataDir, '--slugs-file', slugsFile, '--model', MODEL, '--effort', EFFORT, '--concurrency', '1',
  ]);
  if (ai.exitCode !== 0) problem(`成分读取退出码 ${ai.exitCode}：${lastLine(ai.all)}`);
  for (const r of waiting) {
    const answer = await readJson(resultPath(dataDir, r.source_key));
    if (answer && answer.extracted_at >= startedAt) report.model.tokens += answer.tokens ?? 0;
  }
  // Merge whatever was answered, even when some letters failed.
  const merge = await node('src/run.mjs', ['--data-dir', dataDir, '--sources', 'fda_warning_letters', '--offline']);
  if (merge.exitCode !== 0) {
    problem(`成分合并退出码 ${merge.exitCode}：${lastLine(merge.all)}`);
    return;
  }
  const still = waitingForModel(await loadKind(join(dataDir, 'warning_letter.jsonl')));
  Object.assign(report.model, { read: waiting.length - still.length, still_waiting: still.length });
  if (still.length) problem(`${still.length} 封补充剂类警告信没读到成分：${still.map((r) => r.source_key).slice(0, 5).join(', ')}`);
}

// ── 3. Push new and changed records ─────────────────────────────────────────

// What Supply Smart stores and compares: a record is pushed again when one of these changed.
const pushedState = (r) => [r.content_hash, r.published_date, r.first_seen_at, r.removed_at].map((v) => v ?? '').join('|');

async function push(supplySmart) {
  const manifest = await readJson(join(dataDir, 'manifest.json'));
  const runId = manifest.run_id;
  const records = new Map();
  for (const kind of KINDS) for (const [key, r] of await loadKind(join(dataDir, `${kind}.jsonl`))) records.set(key, r);

  // The ledger holds the state of every record Supply Smart confirmed. A run's
  // cut into batches is kept, so a retry sends the same batch ids with the same events.
  const ledgerFile = join(syncDir, 'ledger.json');
  const ledger = (await readJson(ledgerFile)) ?? { pushed: {} };
  const planDir = join(syncDir, 'runs', runId);
  const planFile = join(planDir, 'plan.json');
  const plan = (await readJson(planFile)) ?? { run_id: runId, created_at: startedAt, batches: [] };
  const inOpenBatch = new Set();
  for (const b of plan.batches.filter((b) => !b.pushed))
    for (const r of await readJson(join(planDir, b.file))) inOpenBatch.add(recordKey(r));
  const due = [...records.values()]
    .filter((r) => ledger.pushed[recordKey(r)] !== pushedState(r) && !inOpenBatch.has(recordKey(r)))
    .sort((a, b) => recordKey(a).localeCompare(recordKey(b)));
  for (let i = 0; i < due.length; i += BATCH_SIZE) {
    const id = String(plan.batches.length + 1).padStart(4, '0');
    const events = due.slice(i, i + BATCH_SIZE);
    await writeJson(join(planDir, `batch-${id}.json`), events);
    plan.batches.push({ id, file: `batch-${id}.json`, events: events.length, pushed: false });
  }
  await writeJson(planFile, plan);

  const open = plan.batches.filter((b) => !b.pushed);
  const summary = { run_id: runId, endpoint: supplySmart.endpoint, batches: open.length, events: 0, dry: zero(), counted: zero(), pushed_batches: 0 };
  report.push = summary;
  if (!open.length) return summary;
  const sourceRuns = manifest.sources;
  const send = async (batch, dryRun) => {
    const events = await readJson(join(planDir, batch.file));
    const answer = await supplySmart.ingest({ run: { runId, sourceRuns }, batchId: batch.id, events, dryRun });
    if (answer.counts.received !== events.length || answer.counts.events !== events.length)
      throw new Error(`batch ${batch.id}: sent ${events.length}, Supply Smart received ${answer.counts.received} / kept ${answer.counts.events}`);
    return { events, answer };
  };

  // Dry run of every open batch first: a bad record or a conflict stops before anything is written.
  for (const batch of open) {
    try {
      const { events, answer } = await send(batch, true);
      summary.events += events.length;
      add(summary.dry, answer.counts);
    } catch (error) {
      problem(`推送 dry run 失败（批次 ${batch.id}）：${error.message}`, error.data);
      return summary;
    }
  }
  if (args['dry-run']) return summary;

  for (const batch of open) {
    try {
      const { events, answer } = await send(batch, false);
      // A batch counted before (e.g. a timeout after it committed) reports what was counted then.
      add(summary.counted, answer.duplicateBatch ? answer.firstReceived : answer.counts);
      await writeJson(join(planDir, `batch-${batch.id}.result.json`), { ...answer, results: undefined, result_count: answer.results.length });
      batch.pushed = true;
      batch.sync_run_id = answer.syncRunId;
      for (const r of events) ledger.pushed[recordKey(r)] = pushedState(r);
      await writeJson(ledgerFile, ledger);
      await writeJson(planFile, plan);
      summary.pushed_batches += 1;
    } catch (error) {
      problem(`推送失败（批次 ${batch.id}，已推 ${summary.pushed_batches}/${open.length} 批）：${error.message}`, error.data);
      return summary;
    }
  }
  summary.sync_run_id = plan.batches.at(-1).sync_run_id ?? null;
  return summary;
}

const zero = () => ({ inserted: 0, updated: 0, unchanged: 0 });
function add(total, counts) {
  for (const k of Object.keys(total)) total[k] += counts?.[k] ?? 0;
}

// ── 4. Compare with Supply Smart ────────────────────────────────────────────

async function compareCloud(supplySmart, pushed) {
  const local = {};
  for (const kind of KINDS) local[kind] = [...(await loadKind(join(dataDir, `${kind}.jsonl`))).values()].filter((r) => !r.removed_at).length;
  const overview = await supplySmart.overview({ includeFood: true });
  const cloud = Object.fromEntries(KINDS.map((k) => [k, overview.total?.[k] ?? null]));
  const mismatched = KINDS.filter((k) => cloud[k] !== local[k]);
  report.cloud = { total: cloud, local, last_synced_at: overview.lastSyncedAt ?? null, matches: mismatched.length === 0 };
  // After a dry run, or a push that stopped, the cloud may rightly still lag behind.
  const complete = !args['dry-run'] && pushed && pushed.pushed_batches === pushed.batches;
  if (complete && mismatched.length)
    problem(`云端条数和本地不一致：${mismatched.map((k) => `${KIND_NAMES[k]} 云端 ${cloud[k]} / 本地 ${local[k]}`).join('，')}`);
}

// ── 5. Message ──────────────────────────────────────────────────────────────

function message() {
  const when = new Date(startedAt).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const title = `Regulatory 同步${report.dry_run ? '（dry run）' : ''}${report.ok ? '完成' : '有问题'} ${when}`;
  const lines = [];
  if (!report.ok) lines.push('**问题**', ...report.problems.map((p) => `- ${p}`), '');
  if (report.crawl?.sources) {
    const parts = Object.entries(report.crawl.sources).map(
      ([name, s]) => `${name} 新${s.new}/改${s.updated}/删${s.removed}${s.blocked ? `/被拦${s.blocked}` : ''}`,
    );
    lines.push(`采集：${parts.join('；')}`);
  }
  if (report.model?.letters)
    lines.push(`成分（${MODEL} ${EFFORT}）：${report.model.letters} 封待读，读到 ${report.model.read} 封，约 ${report.model.tokens.toLocaleString('en-US')} token`);
  if (report.push) {
    const p = report.push;
    const c = report.dry_run ? p.dry : p.counted;
    lines.push(
      p.batches
        ? `推送：${p.events} 条，${p.batches} 批${report.dry_run ? '' : `（已推 ${p.pushed_batches}）`}；新增 ${c.inserted}、更新 ${c.updated}、未变 ${c.unchanged}`
        : '推送：没有新增或变化的记录',
    );
  }
  if (report.cloud)
    lines.push(
      `云端：${KINDS.map((k) => `${KIND_NAMES[k]} ${report.cloud.total[k]}`).join('，')}${report.cloud.matches ? '（与本地一致）' : `（本地 ${KINDS.map((k) => report.cloud.local[k]).join('/')}）`}`,
    );
  return { title, markdown: lines.join('\n'), color: report.ok ? 'purple' : 'red' };
}

// ── Run ────────────────────────────────────────────────────────────────────

const notifier = await feishuNotifier(args['webhook-file'], { log });
// A sync still running (or one that died within the last 6 h) holds the lock: report it and leave.
const release = await lockfile
  .lock(dataDir, { lockfilePath: join(dataDir, '.sync.lock'), stale: 6 * 60 * 60 * 1000, update: 60 * 1000 })
  .catch((error) => {
    problem(`上一次同步还没结束，本次没有运行：${error.message}`);
    return null;
  });
try {
  if (!release) throw new Error('lock held');
  if (!args['skip-crawl']) await crawl();
  if (!args['no-model']) await readIngredients();
  const supplySmart = await supplySmartFromEnvFile(args['supply-smart-env'], { log });
  const pushed = await push(supplySmart);
  await compareCloud(supplySmart, pushed);
} catch (error) {
  if (release) problem(`同步中断：${error.message}`, { stack: error.stack });
} finally {
  report.finished_at = new Date().toISOString();
  report.ok = report.problems.length === 0;
  const card = message();
  report.summary_text = `${card.title}\n${card.markdown}`;
  await writeJson(join(dataDir, 'last-sync.json'), report);
  report.notification = await notifier.send(card);
  await writeJson(join(dataDir, 'last-sync.json'), report);
  // The daily overdue check (src/check-sync.mjs) only counts full runs: a manual dry run proves nothing.
  if (release && !args['dry-run'] && !args['skip-crawl']) await writeJson(join(syncDir, 'last-full-sync.json'), report);
  log.info({ ok: report.ok, problems: report.problems.length, notification: report.notification }, 'sync finished');
  await release?.();
  process.exitCode = report.ok ? 0 : 1;
}
