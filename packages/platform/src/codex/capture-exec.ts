import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { execa } from "execa";
import {
  recordPermitExecution,
  provePermitExecutionStopped,
} from "../execution/permit-execution.js";
import { codexConnection } from "./connection.js";
import type { CodexExecutionConfig } from "./connection-settings.js";
import { codexFailure } from "./errors.js";
import { captureArguments } from "./capture-profile.js";
import { stopCaptureGroup } from "./capture-stop.js";

export interface CodexCaptureInput {
  cwd: string;
  prompt: string;
  outputSchema: object;
  environment: NodeJS.ProcessEnv;
  captureMode?: "product" | "catalog" | "analysis";
  /** Codex's own web search; off unless a task asks for it (brand research, owner 2026-10-09). */
  webSearch?: "live" | "disabled";
  writableDirectories?: string[];
  profileDir?: string;
  /** Waits before each new attempt after a capacity refusal; defaults to CAPACITY_RETRY_DELAYS_MS. */
  capacityRetryDelaysMs?: readonly number[];
}

/** Waits before the next attempt when the provider refused the turn before any work (owner 2026-10-06). */
export const CAPACITY_RETRY_DELAYS_MS: readonly number[] = [60_000, 180_000];

/** Full tools are isolated to capture; text/vision app-server settings remain evidence-only. */
export async function runCodexCapture(
  settings: CodexExecutionConfig,
  input: CodexCaptureInput,
  signal: AbortSignal,
) {
  const schema = join(input.cwd, "output-schema.json");
  const output = join(input.cwd, "result.json");
  await writeFile(schema, JSON.stringify(input.outputSchema), { flag: "wx", mode: 0o600 });
  await writeFile(join(input.cwd, "prompt.txt"), input.prompt, { flag: "wx", mode: 0o600 });
  const waits = input.capacityRetryDelaysMs ?? CAPACITY_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    const failed = await captureAttempt(settings, { ...input, schema, output }, signal);
    if (!failed) {
      return JSON.parse(await readFile(output, "utf8")) as unknown;
    }
    const wait = waits[attempt];
    if (failed.code !== "TEXT.CODEX_MODEL_CAPACITY" || wait === undefined) {
      throw failed;
    }
    await keepAttempt(input.cwd, attempt + 1);
    await delay(wait, undefined, { signal });
  }
}

/** An earlier attempt's process records stay beside the final ones under numbered names. */
async function keepAttempt(cwd: string, attempt: number): Promise<void> {
  for (const [name, extension] of [
    ["events", "jsonl"],
    ["stderr", "txt"],
    ["process", "json"],
  ]) {
    await rename(
      join(cwd, `${name}.${extension}`),
      join(cwd, `${name}.attempt-${attempt}.${extension}`),
    );
  }
}

/**
 * The provider's "model is at capacity" before any item ran means nothing was executed in the browser or the
 * workspace, so the same task may start again. A refusal after work began is not retried.
 */
async function refusedForCapacity(cwd: string): Promise<boolean> {
  const events = (await readFile(join(cwd, "events.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { type?: string; message?: string; item?: { type?: string } }];
      } catch {
        return [];
      }
    });
  const capacity = events.some((event) => /model is at capacity/i.test(event.message ?? ""));
  const worked = events.some(
    (event) => event.type?.startsWith("item.") && event.item?.type !== "error",
  );
  return capacity && !worked;
}

/** One Codex run with its execution proof; returns the failure instead of throwing it. */
async function captureAttempt(
  settings: CodexExecutionConfig,
  input: CodexCaptureInput & { schema: string; output: string },
  signal: AbortSignal,
) {
  const child = startCapture(settings, input, signal);
  const identity = captureIdentity(child.pid);
  try {
    await recordPermitExecution(identity);
    signal.throwIfAborted();
    child.stdin?.end(input.prompt);
  } catch (error) {
    child.kill("SIGTERM");
    await child;
    await stopCaptureGroup(child.pid);
    throw error;
  }
  const result = await child;
  await proveStopped(child.pid, { cwd: input.cwd, identity, exitCode: result.exitCode });
  signal.throwIfAborted();
  if (!result.failed) {
    return null;
  }
  if (result.timedOut) {
    return codexFailure("TEXT.CODEX_TIMEOUT");
  }
  return (await refusedForCapacity(input.cwd))
    ? codexFailure("TEXT.CODEX_MODEL_CAPACITY", "not_executed")
    : codexFailure("TEXT.CODEX_EXITED");
}

/** The whole process group is gone before the permit's execution counts as stopped. */
async function proveStopped(
  pid: number | undefined,
  at: { cwd: string; identity: ReturnType<typeof captureIdentity>; exitCode: number | undefined },
): Promise<void> {
  await stopCaptureGroup(pid);
  const proof = {
    kind: "capture-process-group-absent",
    pid,
    exitCode: at.exitCode,
    observedAt: new Date().toISOString(),
  };
  await writeFile(join(at.cwd, "process.json"), JSON.stringify(proof), { flag: "wx", mode: 0o600 });
  await provePermitExecutionStopped(at.identity, proof);
}

function captureIdentity(pid: number | undefined) {
  return {
    kind: "codex" as const,
    executionId: randomUUID(),
    pid: pid ?? 0,
    host: hostname(),
    startedAt: new Date().toISOString(),
  };
}

function startCapture(
  settings: CodexExecutionConfig,
  input: CodexCaptureInput & { schema: string; output: string },
  signal: AbortSignal,
) {
  const connection = codexConnection(settings, input.cwd, input.environment);
  return execa(settings.executable, captureArguments(settings, input), {
    cwd: input.cwd,
    env: {
      ...connection.env,
      CRAWL_SITE_PROFILE_DIR: input.profileDir,
      CRAWL_DTC_CAPTURE_MODE: input.captureMode,
    },
    extendEnv: false,
    cancelSignal: signal,
    timeout: settings.timeoutMs,
    killDescendants: true,
    detached: true,
    forceKillAfterDelay: 3000,
    reject: false,
    maxBuffer: 32 * 1024 * 1024,
    stdout: { file: join(input.cwd, "events.jsonl") },
    stderr: { file: join(input.cwd, "stderr.txt") },
  });
}
