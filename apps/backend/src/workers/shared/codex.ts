import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CodexProcessRunner } from "@crawl-automation/runtime";

/**
 * 定位 Codex 的结构化输出 schema。
 *
 * 这里曾经写死相对层级（dist/workers/ 比 dist/ 深一层），改路径后每一次 Codex 调用
 * 都因找不到文件而失败，而且错误只出现在 Codex 的事件日志里——整条处理线静默全灭了
 * 一整晚。现在改成向上查找 + 启动即校验：路径不对就直接起不来，不会再悄悄跑空。
 */
function resolveSchemaPath(fileName: string) {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(directory, fileName);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`codex_schema_not_found:${fileName}（从 ${fileURLToPath(import.meta.url)} 向上找不到）`);
}

const MODEL_PAYLOAD_SCHEMA = resolveSchemaPath("model-payload.schema.json");

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
        schemaPath: MODEL_PAYLOAD_SCHEMA,
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
