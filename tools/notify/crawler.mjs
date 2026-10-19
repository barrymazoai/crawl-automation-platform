// node crawler.mjs report|alert --state-dir <dir> --webhook-file <file> [--at-beijing 9,15] [--dry]
//
// Crawler V3 progress → the 「Supply Smart 服务通知」 Feishu group, run from
// Server 一's crontab (owner 2026-10-19: moved from the Mac mini's launchd,
// same content and frequency). A plain script, no model.
//   report   机器、渠道表（含较上次汇报的增量）、同步、需要注意
//   alert    巡检：只在出现新问题或问题解除时发消息
//   --at-beijing 9,15   cron runs it hourly; it reports only at those Beijing
//                       hours, so the US daylight-saving change does not move it
//   --dry    只打印不发送，不写状态
// Server 一 cannot report itself being down; the Mac mini service monitor does.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { feishuNotifier } from './feishu.mjs';

const run = promisify(execFile);
const API = 'http://127.0.0.1:4188/trpc';
const TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const PM2_BIN = '/Users/server/Applications/Crawler Node.app/Contents/bin';
const PM2_HOME = '/Users/server/apps/crawler-v3/pm2';
const HOSTS = { '100.84.91.3': 'Server 二', '100.114.3.97': 'Windows OCR' };
const CHANNELS = ['amazon', 'dtc', 'costco', 'wholefoods', 'gnc', 'swanson'];
const NAMES = {
  amazon: 'Amazon',
  dtc: 'DTC',
  costco: 'Costco',
  wholefoods: 'Whole Foods',
  gnc: 'GNC',
  swanson: 'Swanson',
};

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'state-dir': { type: 'string' },
    'webhook-file': { type: 'string' },
    'at-beijing': { type: 'string' },
    dry: { type: 'boolean', default: false },
  },
});
const DRY = args.dry;
const STATE = args['state-dir'];
if (!STATE) throw new Error('--state-dir is required');
const log = {
  warn: (fields, message) => console.error(new Date().toISOString(), message, JSON.stringify(fields)),
  error: (fields, message) => console.error(new Date().toISOString(), message, JSON.stringify(fields)),
};

/** Beijing wall time, the time the group reads. */
function beijing(date = new Date()) {
  const part = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { iso: `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}`, hour: Number(part.hour) };
}

async function post(title, md, color) {
  if (DRY) {
    console.log(`[${color}] ${title}\n${md}`);
    return;
  }
  const notifier = await feishuNotifier(args['webhook-file'], { log });
  const result = await notifier.send({ title, markdown: md, color });
  // Unsent: fail without saving state, so the next run compares against the last sent one.
  if (!result.sent) throw new Error(`not sent: ${result.reason}`);
}

async function offlineHosts() {
  const out = (await run(TAILSCALE, ['status'], { timeout: 30_000 }).catch((error) => error)).stdout ?? '';
  const down = [];
  for (const [ip, name] of Object.entries(HOSTS)) {
    const line = out.split('\n').find((l) => l.startsWith(`${ip} `)) ?? '';
    // Tailscale 的状态偶尔会误报 offline，再 ping 一下确认
    if ((!line || line.includes('offline')) && !(await reachable(ip))) down.push(name);
  }
  return down;
}

async function reachable(ip) {
  for (let i = 0; i < 3; i += 1) {
    if (await run('/sbin/ping', ['-c1', '-t3', ip]).then(() => true, () => false)) return true;
  }
  return false;
}

async function api(path, input) {
  const query = input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : '';
  try {
    const response = await fetch(`${API}/${path}${query}`, { signal: AbortSignal.timeout(15_000) });
    return (await response.json()).result.data;
  } catch {
    return null;
  }
}

async function pm2List() {
  try {
    const { stdout } = await run('pm2', ['jlist'], {
      env: { ...process.env, PATH: `${PM2_BIN}:${process.env.PATH}`, PM2_HOME },
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

async function collect() {
  const snap = { at: beijing().iso, offline: await offlineHosts() };
  const [pm2, sync, resources, ...queues] = await Promise.all([
    pm2List(),
    api('productSync.status'),
    api('resources.list'),
    ...CHANNELS.map((channel) => api('queue.status', { channel })),
  ]);
  snap.pm2 = Object.fromEntries(
    pm2.map((p) => [
      p.name,
      {
        status: p.pm2_env.status,
        restarts: p.pm2_env.restart_time ?? 0,
        release: basename(dirname(p.pm2_env.pm_cwd ?? '')).slice(0, 7),
      },
    ]),
  );
  snap.sync = {};
  for (const row of sync?.ledger ?? []) {
    snap.sync[row.channel] ??= {};
    snap.sync[row.channel][row.status] = row.count;
  }
  snap.resources = Object.fromEntries(
    (resources ?? []).map((x) => [x.resourceId, { healthy: x.healthy, reason: x.reason }]),
  );
  snap.queue = {};
  CHANNELS.forEach((c, i) => {
    const q = queues[i];
    if (q) {
      snap.queue[c] = {
        mode: q.mode,
        ...Object.fromEntries(['queued', 'running', 'review', 'completed'].map((k) => [k, q.counts?.[k] ?? 0])),
      };
    }
  });
  return snap;
}

/** 问题清单：key → 说明。key 用来判断问题是新出现的还是已经报过的。 */
function issues(s) {
  const out = {};
  for (const h of s.offline ?? []) out[`offline:${h}`] = `${h} 不在线（Tailscale）`;
  if (s.error) out.api = s.error;
  if (!s.queue) return out;
  if (Object.keys(s.pm2).length === 0) out['pm2:none'] = '读不到 pm2 进程';
  for (const [name, p] of Object.entries(s.pm2)) {
    if (p.status !== 'online') out[`pm2:${name}`] = `进程 ${name} 状态 ${p.status}`;
  }
  for (const [rid, r] of Object.entries(s.resources)) {
    // Owner 2026-10-19: resources marked retired (the old DTC v2 browsers) are not problems.
    if (!r.healthy && !String(r.reason).startsWith('retired')) {
      out[`res:${rid}`] = `资源 ${rid} 不健康${r.reason === 'ready' ? '' : `（${r.reason}）`}`;
    }
  }
  for (const c of CHANNELS) {
    if (!(c in s.queue)) out[`queue:${c}`] = `${NAMES[c]} 队列状态读不到`;
  }
  return out;
}

/** 较上次的变化量；上次没有这个数就返回 null。 */
function diff(cur, prev, ...keys) {
  for (const k of keys) {
    if (!prev || typeof prev !== 'object' || !(k in prev)) return null;
    prev = prev[k];
  }
  return cur - prev;
}

const fmt = (d) => (d === null ? '' : d > 0 ? `+${d}` : String(d));

async function load(name) {
  try {
    return JSON.parse(await readFile(join(STATE, name), 'utf8'));
  } catch {
    return null;
  }
}

async function save(name, obj) {
  if (DRY) return;
  await mkdir(STATE, { recursive: true });
  await writeFile(join(STATE, name), JSON.stringify(obj, null, 1));
}

async function report() {
  if (args['at-beijing']) {
    const hours = args['at-beijing'].split(',').map(Number);
    if (!hours.includes(beijing().hour)) return;
  }
  const s = await collect();
  const prev = (await load('report-last.json')) ?? {};
  const iss = issues(s);
  const q = s.queue ?? {};
  const has = Object.keys(q).length > 0;
  const lines = [];
  if (has) {
    const running = CHANNELS.filter((c) => ![undefined, null, 'paused'].includes(q[c]?.mode)).map((c) => NAMES[c]);
    let head = running.length ? `在跑：${running.join('、')}` : '所有渠道都暂停中';
    if (prev.queue && Object.keys(prev.queue).length) {
      const done = Object.keys(q).reduce((n, c) => n + (diff(q[c].completed, prev, 'queue', c, 'completed') ?? 0), 0);
      head += `；较上次新完成 ${done}`;
    }
    const n = Object.keys(iss).length;
    lines.push(
      `**${head}**，${n ? `有 ${n} 个问题` : '一切正常'}。`,
      '',
      '| 渠道 | 状态 | 完成 | 增量 | 排队 | 在跑 | 待复核 |',
      '|---|---|---|---|---|---|---|',
    );
    for (const c of CHANNELS) {
      if (!(c in q)) continue;
      const x = q[c];
      const rv = fmt(diff(x.review, prev, 'queue', c, 'review'));
      lines.push(
        `| ${NAMES[c]} | ${x.mode === 'paused' ? '暂停' : x.mode} | ${x.completed} ` +
          `| ${fmt(diff(x.completed, prev, 'queue', c, 'completed'))} | ${x.queued} ` +
          `| ${x.running} | ${x.review}${rv ? ` (${rv})` : ''} |`,
      );
    }
    lines.push('', '**同步到 Supply Smart**（verified / failed，括号内为较上次）');
    for (const [c, v] of Object.entries(s.sync).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const ver = v.verified ?? 0;
      const fail = v.failed ?? 0;
      const dv = fmt(diff(ver, prev, 'sync', c, 'verified'));
      const df = fmt(diff(fail, prev, 'sync', c, 'failed'));
      lines.push(`- ${NAMES[c] ?? c}：${ver}${dv ? ` (${dv})` : ''} / ${fail}${df ? ` (${df})` : ''}`);
    }
    const pm2 = Object.values(s.pm2);
    const releases = [...new Set(pm2.map((p) => p.release))].sort().join('/');
    lines.push(
      '',
      `进程 ${pm2.filter((p) => p.status === 'online').length}/${pm2.length} 在线，` +
        `版本 ${releases}，累计重启 ${pm2.reduce((sum, p) => sum + p.restarts, 0)}`,
    );
  } else {
    lines.push(`**读不到爬虫数据**，有 ${Object.keys(iss).length} 个问题。`);
  }
  if (Object.keys(iss).length) lines.push('', '**需要注意**', ...Object.values(iss).map((v) => `- ${v}`));
  if (prev.at) lines.push('', `<font color='grey'>对比基准：${prev.at.replace('T', ' ')}</font>`);
  const title = `爬虫进度 ${s.at.slice(5, 10)} ${s.at.slice(11)}`;
  await post(title, lines.join('\n'), Object.keys(iss).length ? 'red' : 'purple');
  if (has) await save('report-last.json', s);
}

async function alert() {
  // 连续两次巡检都出现才告警，连续两次都消失才算恢复，避免一次抖动就发消息
  const s = await collect();
  const now = issues(s);
  const last = (await load('alert-last.json')) ?? {};
  const seen = last.seen ?? {};
  let reported = last.reported ?? {};
  const pick = (obj, keep) => Object.fromEntries(Object.entries(obj).filter(([k]) => keep(k)));
  const fresh = pick(now, (k) => k in seen && !(k in reported));
  const gone = pick(reported, (k) => !(k in now) && !(k in seen));
  const hasNew = Object.keys(fresh).length > 0;
  const hasGone = Object.keys(gone).length > 0;
  if (hasNew || hasGone) {
    const lines = [
      ...Object.values(fresh).map((v) => `- 🔴 ${v}`),
      ...Object.values(gone).map((v) => `- ✅ 已恢复：${v}`),
    ];
    if (hasGone && !hasNew && Object.keys(now).length) lines.push(`\n仍有 ${Object.keys(now).length} 个问题未解决。`);
    await post(hasNew ? '爬虫告警' : '爬虫告警解除', lines.join('\n'), hasNew ? 'red' : 'green');
  }
  reported = pick({ ...reported, ...fresh }, (k) => !(k in gone));
  await save('alert-last.json', { at: s.at, seen: now, reported });
}

const commands = { report, alert };
if (!commands[positionals[0]]) throw new Error('usage: crawler.mjs report|alert --state-dir <dir> …');
await commands[positionals[0]]();
