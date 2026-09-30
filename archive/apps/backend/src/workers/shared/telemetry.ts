import { exec, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Codex 额度来自独立脚本 scripts/mac/codex-usage.mjs（可以手动跑来调试）。
 * 解析逻辑不再内嵌在 worker 里：以后 Codex CLI 出了官方查询命令，
 * 只要把 CODEX_USAGE_COMMAND 指过去即可，worker 代码一行都不用改。
 */
function defaultUsageCommand() {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(directory, "scripts", "mac", "codex-usage.mjs");
    if (existsSync(candidate)) return `node ${JSON.stringify(candidate)}`;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
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
  const resolved = command ?? defaultUsageCommand();
  let cache: { value: CodexTelemetry | null; at: number } | null = null;
  if (!resolved) console.error(JSON.stringify({ type: "codex_usage_command_missing" }));
  return async () => {
    if (!resolved) return null;
    if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
    const value = await codexFromCommand(resolved);
    if (!value) console.error(JSON.stringify({ type: "codex_usage_probe_empty", command: resolved }));
    cache = { value, at: Date.now() };
    return value;
  };
}
