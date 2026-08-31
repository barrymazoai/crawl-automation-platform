import { exec, execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { DiskGuard } from "../../v2/disk-guard.js";

/**
 * 心跳遥测：磁盘背压、出口轮动（含当前 IP）、Codex 余量。
 * 控制面把各节点上报的 extras 汇总进 summary，网页据此渲染顶部状态带。
 */

const TTL_MS = 5 * 60_000;

export type DiskTelemetry = { freeGb: number; softGb: number; hardGb: number; state: "normal" | "soft" | "hard" };
export type EgressTelemetry = { channel: string; exitId: string; ip: string | null; exits: string[]; updatedAt: string };
export type CodexTelemetry = { fiveHourPercentLeft: number | null; weeklyPercentLeft: number | null; resetsAt: string | null; updatedAt: string };

export async function diskTelemetry(guard: DiskGuard, softGb: number, hardGb: number): Promise<DiskTelemetry | null> {
  const freeGb = await guard.freeGb().catch(() => null);
  if (freeGb == null) return null;
  return {
    freeGb: Math.round(freeGb * 10) / 10,
    softGb, hardGb,
    state: freeGb < hardGb ? "hard" : freeGb < softGb ? "soft" : "normal",
  };
}

/** 出口真实 IP：经出口代理请求回显服务，按出口缓存 5 分钟（切出口立即失效）。 */
export function createEgressIpProbe(proxyUrl: string | undefined) {
  let cache: { exitId: string; ip: string | null; at: number } | null = null;
  return async (exitId: string) => {
    if (!proxyUrl) return null;
    if (cache && cache.exitId === exitId && Date.now() - cache.at < TTL_MS) return cache.ip;
    const ip = await new Promise<string | null>((resolve) => {
      execFile("curl", ["-sf", "--max-time", "8", "-x", proxyUrl, "https://api.ipify.org"], (error, stdout) => {
        resolve(error ? null : /^[0-9a-fA-F.:]{3,45}$/.test(stdout.trim()) ? stdout.trim() : null);
      });
    });
    cache = { exitId, ip, at: Date.now() };
    return ip;
  };
}

const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

function findRateLimits(value: unknown): Record<string, any> | null {
  if (Array.isArray(value)) { for (const item of value) { const hit = findRateLimits(item); if (hit) return hit; } return null; }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.rate_limits && typeof record.rate_limits === "object") return record.rate_limits as Record<string, any>;
  for (const item of Object.values(record)) { const hit = findRateLimits(item); if (hit) return hit; }
  return null;
}

async function newestRolloutFile() {
  const listDesc = async (dir: string, pattern: RegExp) =>
    (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => pattern.test(name)).sort().reverse();
  for (const year of await listDesc(CODEX_SESSIONS_DIR, /^\d{4}$/)) {
    for (const month of await listDesc(path.join(CODEX_SESSIONS_DIR, year), /^\d{2}$/)) {
      for (const day of await listDesc(path.join(CODEX_SESSIONS_DIR, year, month), /^\d{2}$/)) {
        const directory = path.join(CODEX_SESSIONS_DIR, year, month, day);
        const files = await Promise.all((await listDesc(directory, /\.jsonl$/)).map(async (name) => {
          const filename = path.join(directory, name);
          return { filename, mtime: (await fs.stat(filename).catch(() => null))?.mtimeMs ?? 0 };
        }));
        const newest = files.sort((a, b) => b.mtime - a.mtime)[0];
        if (newest) return newest.filename;
      }
    }
  }
  return null;
}

/** 解析最新会话 rollout 里的限额快照；按窗口时长映射为 5 小时窗口与周限额。 */
async function codexFromRollouts(): Promise<CodexTelemetry | null> {
  const filename = await newestRolloutFile();
  if (!filename) return null;
  const handle = await fs.open(filename, "r");
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, 2_000_000);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (size > length) lines.shift();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index]!.includes('"rate_limits"')) continue;
      try {
        const parsed = JSON.parse(lines[index]!);
        const snapshot = findRateLimits(parsed);
        if (!snapshot) continue;
        const windows = [snapshot.primary, snapshot.secondary].filter((window) => window && typeof window.used_percent === "number");
        const fiveHour = windows.find((window) => window.window_minutes != null && window.window_minutes <= 24 * 60) ?? null;
        const weekly = windows.find((window) => window.window_minutes != null && window.window_minutes > 24 * 60) ?? null;
        const left = (window: any) => window ? Math.max(0, Math.min(100, Math.round((100 - window.used_percent) * 10) / 10)) : null;
        const resets = (window: any) => window?.resets_at ? new Date(window.resets_at * 1000).toISOString() : null;
        return {
          fiveHourPercentLeft: left(fiveHour),
          weeklyPercentLeft: left(weekly),
          resetsAt: resets(fiveHour) ?? resets(weekly),
          updatedAt: typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString(),
        };
      } catch { /* 半行/损坏行跳过 */ }
    }
    return null;
  } finally { await handle.close(); }
}

async function codexFromCommand(command: string): Promise<CodexTelemetry | null> {
  return new Promise((resolve) => {
    exec(command, { timeout: 30_000 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const parsed = z.object({
          fiveHourPercentLeft: z.number().min(0).max(100).nullish(),
          weeklyPercentLeft: z.number().min(0).max(100).nullish(),
          resetsAt: z.string().nullish(),
        }).parse(JSON.parse(stdout));
        resolve({
          fiveHourPercentLeft: parsed.fiveHourPercentLeft ?? null,
          weeklyPercentLeft: parsed.weeklyPercentLeft ?? null,
          resetsAt: parsed.resetsAt ?? null,
          updatedAt: new Date().toISOString(),
        });
      } catch { resolve(null); }
    });
  });
}

/** Codex 余量采集器（5 分钟缓存）：默认解析会话 rollout，配了命令则优先用命令。 */
export function createCodexQuotaProbe(command?: string) {
  let cache: { value: CodexTelemetry | null; at: number } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
    const value = command ? await codexFromCommand(command) : await codexFromRollouts().catch(() => null);
    cache = { value, at: Date.now() };
    return value;
  };
}
