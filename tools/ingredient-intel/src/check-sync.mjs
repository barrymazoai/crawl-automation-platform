// node src/check-sync.mjs --data-dir <dir> --webhook-file <file> [--max-age-hours 102]
//
// Daily from crontab, as the regulatory sync's check: the job runs Tuesday and Friday, so the longest normal
// gap is 96 h. When <dir>/last-full-sync.json (written by every full scheduled run) is missing or older than
// --max-age-hours, the 「Supply Smart 服务通知」 group gets one red card per missed run.
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pino from 'pino';
import { feishuNotifier } from '../../notify/feishu.mjs';
import { readJson, writeJson } from './lib/state.mjs';

const { values: args } = parseArgs({
  options: {
    'data-dir': { type: 'string', default: process.env.INGREDIENT_INTEL_DATA_DIR },
    'webhook-file': { type: 'string' },
    'max-age-hours': { type: 'string', default: '102' },
  },
});
if (!args['data-dir']) throw new Error('--data-dir (or INGREDIENT_INTEL_DATA_DIR) is required');
const dataDir = resolve(args['data-dir']);
const log = pino({ timestamp: pino.stdTimeFunctions.isoTime });
const maxAgeHours = Number(args['max-age-hours']);

const last = await readJson(join(dataDir, 'last-full-sync.json'));
const finished = last?.finished_at ? new Date(last.finished_at) : null;
const ageHours = finished ? (Date.now() - finished) / 3_600_000 : Infinity;
const stateFile = join(dataDir, 'overdue-alert.json');
const state = (await readJson(stateFile)) ?? {};

if (ageHours <= maxAgeHours) {
  log.info({ run: last.run_id, ageHours: Math.round(ageHours) }, 'last sync is recent');
} else if (state.alerted_for === (last?.run_id ?? null)) {
  log.warn({ run: last?.run_id, ageHours: Math.round(ageHours) }, 'overdue, already reported');
} else {
  const when = (d) => d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const markdown = last
    ? [
        finished
          ? `上一次完整同步结束于北京时间 ${when(finished)}，已经 ${Math.round(ageHours)} 小时没有新的同步（正常最长 96 小时）。`
          : '上一次完整同步没有结束时间（文件不完整）。',
        `上一次结果：${last.ok ? '完成' : `有问题（${last.problems.length} 个）`}。`,
        '',
        `请查看 Server 一 的 crontab 和 \`${join(dataDir, 'logs', 'cron.log')}\`。`,
      ].join('\n')
    : `\`${join(dataDir, 'last-full-sync.json')}\` 不存在，完整同步还没有运行过或文件丢失。`;
  const notifier = await feishuNotifier(args['webhook-file'], { log });
  const result = await notifier.send({ title: '品牌原料同步没有按时运行', markdown, color: 'red' });
  log.error({ run: last?.run_id, ageHours: Math.round(ageHours), notification: result }, 'sync overdue');
  if (result.sent) await writeJson(stateFile, { alerted_for: last?.run_id ?? null, alerted_at: new Date().toISOString() });
  process.exitCode = 1;
}
