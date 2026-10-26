// node src/sync.mjs --data-dir <dir> --supply-smart-env <file> --trials-data-dir <dir>
//   --luna-model gpt-5.6-luna --luna-effort medium [--webhook-file <file>]
//   [--skip-trials] [--no-model] [--max-model-batches 40]
//
// The scheduled job (owner 2026-10-26: Tuesday and Friday, one hour after the regulatory sync, Server 一):
//   1. trials: the ClinicalTrials.gov collector, incremental collect + delivery (src/trials.mjs);
//   2. names: every Supply Smart ingredient name matched to the branded ingredients; the links that changed
//      since the last run go to runs/<id>/changes/alias_links.jsonl, saved only when steps 2–3 succeed
//      (src/names.mjs);
//   3. judge: ®/™ spellings of new names, prior judgements first, the rest by Luna (src/judge.mjs); a
//      spelling tied to a registered ingredient becomes an alias, so step 2 runs again for it;
//   4. <dir>/last-sync.json and a card to the 「Supply Smart 服务通知」 Feishu group.
// P1 writes files only: nothing is pushed to Supply Smart until it has an ingest procedure (P4).
// The model and effort have no defaults (owner rule: never the machine's Codex default); they come from the
// crontab line, so changing the model needs no code change.
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pino from 'pino';
import lockfile from 'proper-lockfile';
import { feishuNotifier } from '../../notify/feishu.mjs';
import { judgeSpellings } from './judge.mjs';
import { linkNames, saveLinks } from './names.mjs';
import { refreshTrials } from './trials.mjs';
import { supplySmartFromEnvFile } from './lib/supply-smart.mjs';
import { writeJson } from './lib/state.mjs';

const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
  options: {
    'data-dir': { type: 'string', default: process.env.INGREDIENT_INTEL_DATA_DIR },
    'supply-smart-env': { type: 'string' },
    'trials-data-dir': { type: 'string' },
    'luna-model': { type: 'string' },
    'luna-effort': { type: 'string' },
    'webhook-file': { type: 'string' },
    'skip-trials': { type: 'boolean', default: false },
    'no-model': { type: 'boolean', default: false },
    'max-model-batches': { type: 'string', default: '40' },
  },
});
if (!args['data-dir']) throw new Error('--data-dir (or INGREDIENT_INTEL_DATA_DIR) is required');
if (!args['supply-smart-env']) throw new Error('--supply-smart-env <file> is required');
if (!args['skip-trials'] && !args['trials-data-dir']) throw new Error('--trials-data-dir is required (or --skip-trials)');
if (!args['no-model'] && (!args['luna-model'] || !args['luna-effort'])) throw new Error('--luna-model and --luna-effort are required (or --no-model)');
const maxBatches = Number(args['max-model-batches']);
if (!Number.isInteger(maxBatches) || maxBatches < 0) throw new Error('--max-model-batches must be a whole number');

const dataDir = resolve(args['data-dir']);
const startedAt = new Date().toISOString();
const runId = startedAt.replace(/[:.]/g, '-');
const runDir = join(dataDir, 'runs', runId);
await mkdir(join(runDir, 'changes'), { recursive: true });
const log = pino(
  { base: { run: runId }, timestamp: pino.stdTimeFunctions.isoTime },
  pino.multistream([{ stream: process.stdout }, { stream: pino.destination({ dest: join(runDir, 'run.log'), sync: true }) }]),
);

const report = {
  run_id: runId,
  started_at: startedAt,
  finished_at: null,
  pushed: false,
  ok: false,
  problems: [],
  trials: null,
  names: null,
  judge: null,
  relinked: null,
};
const problem = (text, detail) => {
  report.problems.push(text);
  log.error({ detail }, text);
};

async function ingredients(supplySmart) {
  const names = await supplySmart.ingredientNames();
  log.info({ names: names.length }, 'ingredient names read');
  const step = { dataDir, runDir, supplySmart, names, now: startedAt, log, problem };
  const linked = await linkNames(step);
  report.names = linked.summary;
  if (args['no-model']) return saveLinks({ ...step, ...linked });
  const judged = await judgeSpellings({
    ...step,
    runId,
    registry: linked.registry,
    links: linked.links,
    fresh: linked.fresh,
    spellings: linked.spellings,
    seen: linked.seen,
    model: args['luna-model'],
    effort: args['luna-effort'],
    maxBatches,
  });
  report.judge = judged.summary;
  // New aliases link old and new names at once; the second pass reports only those links (its problems were
  // already reported by the first).
  if (!judged.aliasesAdded.length) return saveLinks({ ...step, ...linked });
  const relinked = await linkNames({ ...step, problem: () => {}, previous: linked.map });
  report.relinked = relinked.summary;
  await saveLinks({ ...step, ...relinked, changes: [...linked.changes, ...relinked.changes] });
}

// ── Message ────────────────────────────────────────────────────────────────

function message() {
  const when = new Date(startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const title = `品牌原料同步（只出报告，未推送）${report.ok ? '完成' : '有问题'} ${when}`;
  const lines = [];
  if (!report.ok) lines.push('**问题**', ...report.problems.map((p) => `- ${p}`), '');
  const t = report.trials;
  if (t?.collect?.counts) {
    const c = t.collect.counts;
    lines.push(`临床试验：读到 ${c.seen} 项，新收 ${c.kept_new}、更新 ${c.kept_updated}；交付 ${t.deliver?.counts?.trials ?? '—'} 项，关联品牌原料 ${t.deliver?.counts?.ingredient_links?.total ?? '—'} 条`);
  } else if (t?.skipped) lines.push(`临床试验：跳过（${t.skipped}）`);
  const n = report.names;
  if (n) {
    const added = n.added + (report.relinked?.added ?? 0);
    const removed = n.removed + (report.relinked?.removed ?? 0);
    lines.push(`原料名：共 ${n.names.toLocaleString('en-US')} 个，新出现 ${n.new_names.toLocaleString('en-US')} 个（带 ®/™ ${n.new_marked_names}）；映射新增 ${added}、取消 ${removed}，现有 ${(report.relinked ?? n).links.toLocaleString('en-US')} 条`);
  }
  const j = report.judge;
  if (j) {
    lines.push(`®/™ 写法：${j.spellings} 个，已是别名 ${j.alias}、沿用以前的判断 ${j.reused}、交给模型 ${j.asked}${j.unanswered ? `、留到下次 ${j.unanswered}` : ''}`);
    if (j.model.batches)
      lines.push(`模型（${j.model.model} ${j.model.effort}）：${j.model.batches} 批，约 ${j.model.tokens.toLocaleString('en-US')} token；结果 ${Object.entries(j.asked_classes).map(([k, v]) => `${k} ${v}`).join('，')}`);
    lines.push(`新别名 ${j.aliases_added}；候选新品牌原料 ${j.candidates}；待人工看 ${j.review}`);
  }
  lines.push(`文件：${runDir}`);
  return { title, markdown: lines.join('\n'), color: report.ok ? 'purple' : 'red' };
}

// ── Run ────────────────────────────────────────────────────────────────────

const notifier = await feishuNotifier(args['webhook-file'], { log });
const release = await lockfile
  .lock(dataDir, { lockfilePath: join(dataDir, '.sync.lock'), stale: 6 * 60 * 60 * 1000, update: 60 * 1000 })
  .catch((error) => {
    problem(`上一次同步还没结束，本次没有运行：${error.message}`);
    return null;
  });
try {
  if (!release) throw new Error('lock held');
  // A failed trials step does not stop the ingredient steps: they share nothing.
  if (!args['skip-trials'])
    report.trials = await refreshTrials({ toolDir: TOOL_DIR, trialsDir: resolve(args['trials-data-dir']), envFile: resolve(args['supply-smart-env']), log, problem }).catch((error) => {
      problem(`临床试验这一步中断：${error.message}`, { stack: error.stack });
      return null;
    });
  await ingredients(await supplySmartFromEnvFile(args['supply-smart-env'], { log }));
} catch (error) {
  if (release) problem(`同步中断：${error.message}`, { stack: error.stack });
} finally {
  report.finished_at = new Date().toISOString();
  report.ok = report.problems.length === 0;
  const card = message();
  report.summary_text = `${card.title}\n${card.markdown}`;
  await writeJson(join(runDir, 'report.json'), report);
  report.notification = await notifier.send(card);
  await writeJson(join(dataDir, 'last-sync.json'), report);
  // The daily overdue check counts only full scheduled runs.
  if (release && !args['skip-trials'] && !args['no-model']) await writeJson(join(dataDir, 'last-full-sync.json'), report);
  log.info({ ok: report.ok, problems: report.problems.length, notification: report.notification }, 'sync finished');
  await release?.();
  process.exitCode = report.ok ? 0 : 1;
}
