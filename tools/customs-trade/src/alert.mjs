// Feishu cards for the customs-trade puller (KAN-282), pure: no network, no files.
//   run.mjs --webhook-file  → successCard after a push, failureCard when a run fails
//   check-sync.mjs          → overdueCard when no push has finished for too long
// The cards go to the 「Supply Smart 服务通知」 group through tools/notify/feishu.mjs, like the regulatory
// and branded-ingredient syncs.

/** Which Supply Smart a host is, for the card title */
export function envLabel(host) {
  if (host === 'app.supplysmart.net') return '生产环境';
  if (host === 'test.supplysmart.net') return '测试环境';
  return host ?? '未知环境';
}

/**
 * An error text safe for a group chat: every value of the private env file, and anything after
 * `key=`, replaced. The clients already name paths, never URLs with the key; this is the backstop.
 */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('<redacted>');
  return out.replace(/([?&]key=)[^&\s"']+/gi, '$1<redacted>');
}

const n = (x) => Number(x ?? 0).toLocaleString('en-US');

/** After a successful --push run */
export function successCard(report) {
  const c = report.counts?.rows ?? {};
  const changed = (c.inserted ?? 0) + (c.updated ?? 0) + (c.restored ?? 0) + (c.removed ?? 0);
  return {
    title: `美国海关数据已同步（${envLabel(report.supplySmart)}）`,
    color: 'green',
    markdown: [
      `**${report.supplySmart}** · 窗口 ${report.window.from} 至 ${report.window.to}（${report.window.months} 个月，最新月份 **${report.window.to}**）`,
      `${report.codes} 个海关编码，${n(report.rows)} 行。`,
      changed
        ? `本次：新增 ${n(c.inserted)}，更新 ${n(c.updated)}，恢复 ${n(c.restored)}，撤回 ${n(c.removed)}；未变 ${n(c.unchanged)}。`
        : `本次没有变化（${n(c.unchanged)} 行未变）：Census 还没有发布新的月份，也没有修订。`,
      `运行：\`${report.runId}\``,
    ].join('\n'),
  };
}

const STAGE = {
  start: '启动（读配置 / 拿运行锁）',
  fetch: '从 Census 读取数据',
  dry: 'dry run（还没有写入任何数据）',
  push: '正式写入（可能只写了部分批次；每个批次按「编码 × 月份」整片覆盖，修好后重跑一次即可补齐）',
};

/** When a run throws; stage is where it stopped */
export function failureCard({ host, stage, error, dataDir }) {
  return {
    title: `美国海关数据同步失败（${envLabel(host)}）`,
    color: 'red',
    markdown: [
      `**${host ?? '未知环境'}** · 停在：${STAGE[stage] ?? stage}`,
      '',
      `错误：${error}`,
      '',
      `日志：Server 一 \`${dataDir}/cron.log\``,
    ].join('\n'),
  };
}

/** The newest report of a run that pushed; reports are runs/<id>/report.json contents */
export function latestPush(reports) {
  return reports
    .filter((r) => r?.pushed && r.fetchedAt)
    .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))[0] ?? null;
}

/** Days since a push, or Infinity without one */
export function ageDays(push, now = new Date()) {
  return push ? (now - new Date(push.fetchedAt)) / 86_400_000 : Infinity;
}

/** No push for longer than maxDays */
export function overdueCard({ push, days, maxDays, label, dataDir }) {
  const when = (d) => new Date(d).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  return {
    title: `美国海关数据没有按时同步（${label}）`,
    color: 'red',
    markdown: [
      push
        ? `上一次成功写入：北京时间 ${when(push.fetchedAt)}（${push.supplySmart}，最新月份 ${push.window?.to}），已经 ${Math.floor(days)} 天（每月 12 号运行，超过 ${maxDays} 天报警）。`
        : `\`${dataDir}/runs\` 里没有成功写入的运行：同步还没跑过，或运行记录丢失。`,
      '',
      `请查看 Server 一 的 crontab 和 \`${dataDir}/cron.log\`。`,
    ].join('\n'),
  };
}
