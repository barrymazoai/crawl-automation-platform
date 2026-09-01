#!/usr/bin/env node
/**
 * 读取 Codex 的额度快照，输出给控制面遥测用的 JSON。
 *
 * Codex CLI 目前没有查询额度的命令，但每次非 --ephemeral 的会话都会把 API 返回的
 * rate_limits 写进 ~/.codex/sessions 的 rollout 文件。worker 每 5 分钟保留一次会话，
 * 这个脚本就从最新的 rollout 里把快照捞出来。
 *
 * 用法：
 *   node scripts/mac/codex-usage.mjs             # 输出 JSON
 *   node scripts/mac/codex-usage.mjs --verbose   # 附带诊断信息（读了哪个文件等）
 *
 * 输出契约（worker 的 CODEX_USAGE_COMMAND 就认这几个字段）：
 *   { fiveHourPercentLeft, weeklyPercentLeft, resetsAt, updatedAt }
 *   剩余百分比取不到时为 null；完全找不到快照则退出码 1。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SESSIONS_DIR = process.env.CODEX_SESSIONS_DIR ?? path.join(os.homedir(), ".codex", "sessions");
const verbose = process.argv.includes("--verbose");
const log = (...args) => { if (verbose) console.error("[codex-usage]", ...args); };

/** 按名称倒序列出匹配的子项（年/月/日目录都是零填充，字典序即时间序）。 */
async function listDesc(directory, pattern) {
  const names = await fs.readdir(directory).catch(() => []);
  return names.filter((name) => pattern.test(name)).sort().reverse();
}

/** 找出最近写入的 rollout 文件：先按 年/月/日 目录倒序定位，再在该天里按 mtime 取最新。 */
async function newestRollout() {
  for (const year of await listDesc(SESSIONS_DIR, /^\d{4}$/)) {
    for (const month of await listDesc(path.join(SESSIONS_DIR, year), /^\d{2}$/)) {
      for (const day of await listDesc(path.join(SESSIONS_DIR, year, month), /^\d{2}$/)) {
        const directory = path.join(SESSIONS_DIR, year, month, day);
        const names = await listDesc(directory, /\.jsonl$/);
        const stats = await Promise.all(names.map(async (name) => {
          const filename = path.join(directory, name);
          const stat = await fs.stat(filename).catch(() => null);
          return { filename, mtime: stat?.mtimeMs ?? 0 };
        }));
        const newest = stats.sort((a, b) => b.mtime - a.mtime)[0];
        if (newest) return newest;
      }
    }
  }
  return null;
}

/** rate_limits 可能嵌在事件对象的不同层级，深度查找第一个对象型的取值。 */
function findRateLimits(value) {
  if (Array.isArray(value)) {
    for (const item of value) { const hit = findRateLimits(item); if (hit) return hit; }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (value.rate_limits && typeof value.rate_limits === "object") return value.rate_limits;
  for (const item of Object.values(value)) { const hit = findRateLimits(item); if (hit) return hit; }
  return null;
}

/** 按窗口时长把额度窗口归类：<=24 小时算 5 小时窗口，更长的算周限额。 */
function classify(snapshot) {
  const windows = [snapshot.primary, snapshot.secondary]
    .filter((window) => window && typeof window.used_percent === "number");
  return {
    short: windows.find((w) => w.window_minutes != null && w.window_minutes <= 24 * 60) ?? null,
    long: windows.find((w) => w.window_minutes != null && w.window_minutes > 24 * 60) ?? null,
  };
}

const percentLeft = (window) =>
  window ? Math.max(0, Math.min(100, Math.round((100 - window.used_percent) * 10) / 10)) : null;
const resetsAt = (window) =>
  window?.resets_at ? new Date(window.resets_at * 1000).toISOString() : null;

async function main() {
  const rollout = await newestRollout();
  if (!rollout) {
    log("在", SESSIONS_DIR, "下没有找到任何 rollout 文件");
    process.exit(1);
  }
  log("读取", rollout.filename);

  // 只读文件尾部：rollout 会越写越大，而我们要的是最后一条快照。
  const handle = await fs.open(rollout.filename, "r");
  let text;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 2_000_000);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    text = buffer.toString("utf8");
    if (size > length) text = text.slice(text.indexOf("\n") + 1);
  } finally { await handle.close(); }

  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line || !line.includes('"rate_limits"')) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    const snapshot = findRateLimits(parsed);
    if (!snapshot) continue;
    const { short, long } = classify(snapshot);
    log("命中快照:", JSON.stringify(snapshot).slice(0, 160));
    console.log(JSON.stringify({
      fiveHourPercentLeft: percentLeft(short),
      weeklyPercentLeft: percentLeft(long),
      resetsAt: resetsAt(short) ?? resetsAt(long),
      updatedAt: typeof parsed.timestamp === "string" ? parsed.timestamp : new Date(rollout.mtime).toISOString(),
      planType: snapshot.plan_type ?? null,
      source: path.basename(rollout.filename),
    }));
    return;
  }
  log("文件里没有可解析的 rate_limits 快照:", rollout.filename);
  process.exit(1);
}

await main();
