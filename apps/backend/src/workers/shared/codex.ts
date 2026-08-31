import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CodexProcessRunner } from "@crawl-automation/runtime";

/** 进程级并发闸门：Codex 限流是账号级的，各 Pool 进程静态切分预算（方案 4）。 */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private limit: number) {}
  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    try { return await action(); }
    finally { this.active -= 1; this.queue.shift()?.(); }
  }
}

const TELEMETRY_TTL_MS = 5 * 60_000;

export interface CodexEnv {
  CODEX_EXECUTABLE: string;
  CODEX_MODEL: string;
  CODEX_REASONING_EFFORT: string;
  CODEX_UNATTENDED_FULL_ACCESS: "true" | "false";
  CODEX_CONCURRENCY: number;
  REPOSITORY_ROOT: string;
}

export function createCodex(env: CodexEnv) {
  const runner = new CodexProcessRunner({
    executable: env.CODEX_EXECUTABLE,
    model: env.CODEX_MODEL,
    reasoningEffort: env.CODEX_REASONING_EFFORT,
    unattendedFullAccess: env.CODEX_UNATTENDED_FULL_ACCESS === "true",
  });
  const slots = new Semaphore(env.CODEX_CONCURRENCY);
  // 每 5 分钟保留一次会话 rollout，供 Codex 余量遥测解析限额快照（其余调用 --ephemeral）。
  let lastPersistAt = 0;
  const shouldPersistSession = () => {
    if (Date.now() - lastPersistAt < TELEMETRY_TTL_MS) return false;
    lastPersistAt = Date.now();
    return true;
  };
  const safeTag = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);

  /** v2 各处理阶段统一的模型调用入口：受并发闸门约束，产出落在 job 目录的 model/ 下。 */
  const runModelPayload = (jobDirectory: string, prompt: string, tag: string, signal: AbortSignal) =>
    slots.run(async () => {
      const name = safeTag(tag);
      const raw = await runner.run({
        prompt,
        cwd: env.REPOSITORY_ROOT,
        addDirectories: [jobDirectory],
        schemaPath: fileURLToPath(new URL("../../../model-payload.schema.json", import.meta.url)),
        outputPath: path.join(jobDirectory, "model", `${name}.result.json`),
        eventLogPath: path.join(jobDirectory, "model", `${name}.events.jsonl`),
        signal,
        persistSession: shouldPersistSession(),
      });
      return z.object({ payload: z.string().min(2) }).parse(raw).payload;
    });

  return { runner, slots, runModelPayload, shouldPersistSession };
}

export type Codex = ReturnType<typeof createCodex>;
