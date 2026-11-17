// node src/check-sync.mjs --data-dir <dir> --webhook-file <file> --label <测试环境|生产环境> [--max-age-days 33]
//
// Daily from crontab, like the regulatory and branded-ingredient checks: the puller runs on the 12th of
// every month, so the longest normal gap is 31 days. When the newest run in <dir>/runs that pushed
// (runs/<id>/report.json with pushed: true) is older than --max-age-days, or there is none, the
// 「Supply Smart 服务通知」 group gets one red card per missed push. A run that fails says so itself
// (run.mjs --webhook-file); this catches the one that never starts. Dry runs (no --push) don't count.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { feishuNotifier } from '../../notify/feishu.mjs';
import { ageDays, latestPush, overdueCard } from './alert.mjs';

const { values: args } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    'webhook-file': { type: 'string' },
    label: { type: 'string' },
    'max-age-days': { type: 'string', default: '33' },
  },
});
if (!args['data-dir'] || !args.label) throw new Error('--data-dir and --label are required');
const dataDir = resolve(args['data-dir']);
const maxDays = Number(args['max-age-days']);
const log = {
  info: (o, msg) => console.error(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg, ...o })),
  warn: (o, msg) => console.error(JSON.stringify({ t: new Date().toISOString(), level: 'warn', msg, ...o })),
  error: (o, msg) => console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', msg, ...o })),
};
const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

const runsDir = join(dataDir, 'runs');
const ids = await readdir(runsDir).catch(() => []);
const reports = await Promise.all(ids.map((id) => readJson(join(runsDir, id, 'report.json'))));
const push = latestPush(reports);
const days = ageDays(push);
const stateFile = join(dataDir, 'overdue-alert.json');
const state = (await readJson(stateFile)) ?? {};

if (days <= maxDays) {
  log.info({ run: push.runId, days: Math.floor(days) }, 'last push is recent');
} else if (state.alerted_for === (push?.runId ?? null)) {
  log.warn({ run: push?.runId, days: Math.floor(days) }, 'overdue, already reported');
} else {
  const notifier = await feishuNotifier(args['webhook-file'], { log });
  const result = await notifier.send(overdueCard({ push, days, maxDays, label: args.label, dataDir }));
  log.error({ run: push?.runId, days: Math.floor(days), notification: result }, 'push overdue');
  if (result.sent)
    await writeFile(stateFile, JSON.stringify({ alerted_for: push?.runId ?? null, alerted_at: new Date().toISOString() }, null, 2));
  process.exitCode = 1;
}
