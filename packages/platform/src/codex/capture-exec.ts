import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
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
  writableDirectories?: string[];
  profileDir?: string;
}

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
  const child = startCapture(settings, { ...input, schema, output }, signal);
  const identity = captureIdentity(child.pid);
  try {
    await recordPermitExecution(identity);
  } catch (error) {
    child.kill("SIGTERM");
    await child;
    await stopCaptureGroup(child.pid);
    throw error;
  }
  const result = await child;
  await stopCaptureGroup(child.pid);
  const proof = {
    kind: "capture-process-group-absent",
    pid: child.pid,
    exitCode: result.exitCode,
    observedAt: new Date().toISOString(),
  };
  await writeFile(join(input.cwd, "process.json"), JSON.stringify(proof), {
    flag: "wx",
    mode: 0o600,
  });
  await provePermitExecutionStopped(identity, proof);
  if (result.failed) {
    throw codexFailure(result.timedOut ? "TEXT.CODEX_TIMEOUT" : "TEXT.CODEX_EXITED");
  }
  signal.throwIfAborted();
  return JSON.parse(await readFile(output, "utf8")) as unknown;
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
    env: { ...connection.env, CRAWL_SITE_PROFILE_DIR: input.profileDir },
    extendEnv: false,
    input: input.prompt,
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
