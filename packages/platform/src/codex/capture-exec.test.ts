import { mkdtemp, writeFile, rm, readFile, realpath, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { withPermitExecution } from "../execution/permit-execution.js";
import { CodexExecutionConfigSchema } from "./connection-settings.js";
import { runCodexCapture } from "./capture-exec.js";

// Process/provider integration checks: run on a Mini, not the controlling MacBook.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(mode: "complete" | "cancel" | "timeout") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dtc-exec-test-")));
  roots.push(root);
  const executable = join(root, "fake-codex");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
const {spawn} = require("node:child_process");
process.stdin.resume();
process.stdin.on("end", () => {
const child = spawn(process.execPath, ["-e", ${JSON.stringify('process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)')}], {stdio:"ignore"});
fs.writeFileSync("descendant.pid", String(child.pid));
${mode === "complete" ? 'fs.writeFileSync(process.argv[process.argv.indexOf("--output-last-message")+1], JSON.stringify({status:"complete",mode:process.env.CRAWL_DTC_CAPTURE_MODE})); child.unref(); process.exit(0);' : "setInterval(()=>{},1000);"}
});
`,
    { mode: 0o700 },
  );
  const settings = CodexExecutionConfigSchema.parse({
    executable,
    codexHome: root,
    workRoot: root,
    runtimeProfileVersion: "test/1",
    timeoutMs: mode === "timeout" ? 1000 : 10000,
    settings: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "medium" },
  });
  return { root, settings };
}

it.each(["complete", "cancel", "timeout"] as const)(
  "proves capture and its children stopped after %s",
  async (mode) => {
    const { root, settings } = await fixture(mode);
    const controller = new AbortController();
    const proofs: object[] = [];
    const started: object[] = [];
    const work = withPermitExecution(
      {
        owner: { permitId: "one", workflowId: "capture", runId: "run" },
        ledger: {
          record: async (_owner, identity) => {
            started.push(identity);
          },
          prove: async (_owner, _identity, proof) => {
            proofs.push(proof);
          },
        },
      },
      () =>
        runCodexCapture(
          settings,
          {
            cwd: root,
            prompt: "test",
            outputSchema: {},
            environment: process.env,
            captureMode: "catalog",
          },
          controller.signal,
        ),
    );
    if (mode === "cancel") {
      const rejected = expect(work).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();
      await rejected;
    } else if (mode === "timeout") {
      await expect(work).rejects.toMatchObject({ code: "TEXT.CODEX_TIMEOUT" });
    } else {
      await expect(work).resolves.toEqual({ status: "complete", mode: "catalog" });
    }
    const pid = Number(await readFile(join(root, "descendant.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(started).toHaveLength(1);
    expect(proofs).toEqual([expect.objectContaining({ kind: "capture-process-group-absent" })]);
    expect(JSON.parse(await readFile(join(root, "process.json"), "utf8"))).toMatchObject({
      kind: "capture-process-group-absent",
    });
  },
);

it("does not send the capture prompt when durable execution registration fails", async () => {
  const { root, settings } = await fixture("complete");
  const work = withPermitExecution(
    {
      owner: { permitId: "one", workflowId: "capture", runId: "run" },
      ledger: {
        record: async () => {
          throw new Error("ledger unavailable");
        },
        prove: async () => undefined,
      },
    },
    () =>
      runCodexCapture(
        settings,
        { cwd: root, prompt: "test", outputSchema: {}, environment: process.env },
        new AbortController().signal,
      ),
  );
  await expect(work).rejects.toThrow("ledger unavailable");
  await expect(access(join(root, "descendant.pid"))).rejects.toMatchObject({ code: "ENOENT" });
});

/** A fake Codex that answers "model is at capacity" on its first `refusals` runs, then completes. */
async function capacityFixture(refusals: number, afterWork = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dtc-exec-capacity-")));
  roots.push(root);
  const executable = join(root, "fake-codex");
  const work = afterWork
    ? 'console.log(JSON.stringify({type:"item.completed",item:{type:"command_execution"}}));'
    : "";
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
const runs = fs.existsSync("runs") ? Number(fs.readFileSync("runs", "utf8")) : 0;
fs.writeFileSync("runs", String(runs + 1));
if (runs < ${refusals}) {
  console.log(JSON.stringify({type:"thread.started"}));
  ${work}
  console.log(JSON.stringify({type:"error",message:"Selected model is at capacity. Please try a different model."}));
  process.exit(1);
}
fs.writeFileSync(process.argv[process.argv.indexOf("--output-last-message")+1], JSON.stringify({status:"complete"}));
process.exit(0);
});
`,
    { mode: 0o700 },
  );
  const settings = CodexExecutionConfigSchema.parse({
    executable,
    codexHome: root,
    workRoot: root,
    runtimeProfileVersion: "test/1",
    timeoutMs: 10000,
    settings: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "medium" },
  });
  const run = (waits: number[]) =>
    withPermitExecution(
      {
        owner: { permitId: "one", workflowId: "capture", runId: "run" },
        ledger: { record: async () => undefined, prove: async () => undefined },
      },
      () =>
        runCodexCapture(
          settings,
          {
            cwd: root,
            prompt: "test",
            outputSchema: {},
            environment: process.env,
            capacityRetryDelaysMs: waits,
          },
          new AbortController().signal,
        ),
    );
  return { root, run };
}

// Owner 2026-10-06: a capacity refusal before any work starts the same task again after a wait.
it("starts again after a capacity refusal and keeps each attempt's records", async () => {
  const { root, run } = await capacityFixture(2);
  await expect(run([1, 1])).resolves.toEqual({ status: "complete" });
  await access(join(root, "events.attempt-1.jsonl"));
  await access(join(root, "process.attempt-2.json"));
  expect(JSON.parse(await readFile(join(root, "process.json"), "utf8"))).toMatchObject({
    exitCode: 0,
  });
});

it("stops with the capacity code when every attempt is refused", async () => {
  const { run } = await capacityFixture(5);
  await expect(run([1])).rejects.toMatchObject({
    code: "TEXT.CODEX_MODEL_CAPACITY",
    executionFact: "not_executed",
  });
});

it("never starts again when the refusal came after work began", async () => {
  const { root, run } = await capacityFixture(1, true);
  await expect(run([1])).rejects.toMatchObject({ code: "TEXT.CODEX_EXITED" });
  expect(await readFile(join(root, "runs"), "utf8")).toBe("1");
});
