import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  withPermitExecution,
  type PermitExecutionIdentity,
} from "../execution/permit-execution.js";
import { targetAbsenceScript } from "./ego-cleanup.js";
import { EgoPages } from "./ego-pages.js";
import { EgoRunner } from "./ego-runner.js";
import { closeTargetScript, EGO_MARKER } from "./ego-script.js";

const owner = { permitId: "permit", workflowId: "workflow", runId: "run" };
const opened = { kind: "opened", targetId: "task-page" };
const result = {
  kind: "result",
  targetId: "task-page",
  closed: true,
  failure: null,
  value: null,
};
const failure = { name: "Error", code: "SITE.READ_FAILED", message: "Original page read failed" };

interface Response {
  messages: unknown[];
  afterRecorded?: unknown[];
  wait?: boolean;
}

/** A local process fixture, never an Ego/browser integration test. */
async function fixture(responses: Response[]) {
  const folder = await mkdtemp(join(tmpdir(), "ego-recovery-"));
  const cliPath = join(folder, "ego-browser");
  const scriptPath = join(folder, "scripts.jsonl");
  const counter = join(folder, "counter");
  const recorded = join(folder, "recorded");
  const source = `#!${process.execPath}
const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const counter = ${JSON.stringify(counter)};
  const index = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(index + 1));
  fs.appendFileSync(${JSON.stringify(scriptPath)}, JSON.stringify(Buffer.concat(chunks).toString()) + '\\n');
  const response = ${JSON.stringify(responses)}[index];
  const emit = message => console.log(${JSON.stringify(EGO_MARKER)} + JSON.stringify(message));
  for (const message of response.messages) emit(message);
  if (response.afterRecorded || response.wait) {
    const timer = setInterval(() => {
      if (!response.afterRecorded || !fs.existsSync(${JSON.stringify(recorded)})) return;
      clearInterval(timer);
      for (const message of response.afterRecorded) emit(message);
    }, 10);
  }
});`;
  await writeFile(cliPath, source);
  await chmod(cliPath, 0o755);
  const settings = { cliPath, taskSpaceId: 7, roundTimeoutMs: 5_000, maxHtmlBytes: 1_024 };
  return {
    settings,
    recorded,
    scripts: async () =>
      (await readFile(scriptPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string),
  };
}

function ledger(onRecord?: (identity: PermitExecutionIdentity) => Promise<void>) {
  return {
    record: vi.fn(async (_owner, identity: PermitExecutionIdentity) => onRecord?.(identity)),
    prove: vi.fn(async () => undefined),
  };
}

function run(
  test: Awaited<ReturnType<typeof fixture>>,
  journal: ReturnType<typeof ledger>,
  signal = new AbortController().signal,
) {
  return withPermitExecution({ owner, ledger: journal }, () =>
    new EgoRunner(test.settings).run("business round", signal),
  );
}

describe("Ego permit stop evidence", () => {
  it("records the exact page while the round is still waiting, after durable round intent", async () => {
    const test = await fixture([{ messages: [opened], afterRecorded: [result] }]);
    const journal = ledger(async (identity) => {
      if (identity.kind === "browser") {
        await writeFile(test.recorded, "durable");
      }
    });
    await expect(run(test, journal)).resolves.toMatchObject({ closed: true });
    expect(journal.record.mock.calls.map(([, identity]) => identity.kind)).toEqual([
      "browser-round",
      "browser",
    ]);
    expect(journal.record).toHaveBeenCalledWith(owner, {
      kind: "browser",
      executionId: "task-page",
      taskSpaceId: 7,
      metadata: { host: hostname() },
    });
    expect(journal.record).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ kind: "browser-round", metadata: { host: hostname() } }),
    );
    expect(journal.prove).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ kind: "browser", executionId: "task-page" }),
      expect.objectContaining({ kind: "browser-target-absent", targetId: "task-page" }),
    );
    expect(journal.prove).toHaveBeenCalledTimes(2);
  });

  it("closes once, rechecks delayed absence, and preserves the business failure", async () => {
    const test = await fixture([
      { messages: [opened, { ...result, closed: false, failure }] },
      { messages: [{ ...result, closed: false }] },
      { messages: [{ ...result, closed: false }] },
      { messages: [result] },
    ]);
    const journal = ledger();
    await expect(
      withPermitExecution({ owner, ledger: journal }, () =>
        new EgoPages(test.settings).round("business round", {}, new AbortController().signal),
      ),
    ).rejects.toMatchObject({ code: "BROWSER.UNAVAILABLE", details: { failure } });
    const scripts = await test.scripts();
    expect(scripts).toHaveLength(4);
    expect(scripts[1]).toContain('"targetId":"task-page"');
    expect(scripts[1]).toContain(".close()");
    for (const script of scripts.slice(2)) {
      expect(script).toContain('"targetId":"task-page"');
      expect(script).not.toContain(".close()");
      expect(script).not.toContain("newPage");
    }
    expect(journal.prove).toHaveBeenCalledTimes(2);
  });

  it("stops after three failed absence checks, retaining identities without proof", async () => {
    const pending = { messages: [{ ...result, closed: false }] };
    const test = await fixture([
      { messages: [opened, { ...result, closed: false, failure }] },
      pending,
      pending,
      pending,
      pending,
    ]);
    const journal = ledger();
    await expect(run(test, journal)).rejects.toMatchObject({
      code: "BROWSER.PAGE_CLEANUP_PENDING",
      details: { opened: ["task-page"], failure },
    });
    expect(await test.scripts()).toHaveLength(5);
    expect(journal.record).toHaveBeenCalledTimes(2);
    expect(journal.prove).not.toHaveBeenCalled();
  });

  it("stops recovery immediately when the space is under user control", async () => {
    const test = await fixture([
      { messages: [opened, { ...result, closed: false }] },
      { messages: [{ kind: "stop", reason: "user-control" }] },
    ]);
    const journal = ledger();
    await expect(run(test, journal)).rejects.toMatchObject({
      code: "BROWSER.PAGE_CLEANUP_PENDING",
      cause: { cause: { code: "BROWSER.USER_CONTROL" } },
    });
    expect(await test.scripts()).toHaveLength(2);
    expect(journal.prove).not.toHaveBeenCalled();
  });

  it("uses an independent cleanup lifetime when the business signal was cancelled", async () => {
    const test = await fixture([
      { messages: [opened], wait: true },
      { messages: [result] },
      { messages: [result] },
    ]);
    const controller = new AbortController();
    const journal = ledger(async (identity) => {
      if (identity.kind === "browser") {
        controller.abort();
      }
    });
    await expect(run(test, journal, controller.signal)).rejects.toMatchObject({
      code: "BROWSER.CANCELLED",
      details: { executionUnknown: true },
    });
    expect(await test.scripts()).toHaveLength(3);
    // The known page is gone, but a missing final result cannot prove the interrupted round ended safely.
    expect(journal.prove).toHaveBeenCalledTimes(1);
    expect(journal.prove).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ kind: "browser", executionId: "task-page" }),
      expect.objectContaining({ kind: "browser-target-absent" }),
    );
  });

  it("does not accept an absence result for another page", async () => {
    const test = await fixture([
      { messages: [opened, { ...result, closed: false }] },
      { messages: [result] },
      ...Array.from({ length: 3 }, () => ({
        messages: [{ ...result, targetId: "unrelated-user-page" }],
      })),
    ]);
    const journal = ledger();
    await expect(run(test, journal)).rejects.toMatchObject({
      code: "BROWSER.PAGE_CLEANUP_PENDING",
    });
    expect(journal.prove).not.toHaveBeenCalled();
  });

  it("retains the round intent if the process exits before reporting any page", async () => {
    const test = await fixture([{ messages: [] }]);
    const journal = ledger();
    await expect(run(test, journal)).rejects.toMatchObject({
      code: "BROWSER.UNAVAILABLE",
      details: { executionUnknown: true },
    });
    expect(journal.record).toHaveBeenCalledTimes(1);
    expect(journal.record).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ kind: "browser-round" }),
    );
    expect(journal.prove).not.toHaveBeenCalled();
  });

  it("leaves an opened page pending without cleanup when the round reports user control", async () => {
    const test = await fixture([{ messages: [opened, { kind: "stop", reason: "user-control" }] }]);
    const journal = ledger();
    await expect(run(test, journal)).rejects.toMatchObject({
      code: "BROWSER.USER_CONTROL",
      details: { opened: ["task-page"] },
    });
    expect(await test.scripts()).toHaveLength(1);
    expect(journal.prove).not.toHaveBeenCalled();
  });
});

describe("read-only target absence script", () => {
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;

  it("checks the exact target without closing another page or taking control", async () => {
    const emitted = vi.fn();
    const task = { ownership: "agent", tabs: vi.fn(async () => [{ targetId: "user-page" }]) };
    const taskSpace = vi.fn(async () => task);
    const script = new AsyncFunction(
      "taskSpace",
      "console",
      targetAbsenceScript({ taskSpaceId: 7, targetId: "task-page" }),
    );
    await script(taskSpace, { log: emitted });
    expect(taskSpace).toHaveBeenCalledWith(7);
    expect(emitted).toHaveBeenCalledWith(expect.stringContaining('"closed":true'));
    expect(task.tabs).toHaveBeenCalledTimes(1);
  });

  it("refuses even an inventory read when user control is observed", async () => {
    const emitted = vi.fn();
    const task = { ownership: "user", tabs: vi.fn() };
    const script = new AsyncFunction(
      "taskSpace",
      "console",
      targetAbsenceScript({ taskSpaceId: 7, targetId: "task-page" }),
    );
    await script(async () => task, { log: emitted });
    expect(task.tabs).not.toHaveBeenCalled();
    expect(emitted).toHaveBeenCalledWith(expect.stringContaining('"reason":"user-control"'));
  });

  it("uses the existing close script only for the exact task target", async () => {
    let present = true;
    const close = vi.fn(async () => {
      present = false;
    });
    const task = {
      ownership: "agent",
      tabs: async () => [
        { targetId: "user-page", label: "user-tab" },
        ...(present ? [{ targetId: "task-page", label: "task-tab" }] : []),
      ],
      page: vi.fn(() => ({ close })),
    };
    const script = new AsyncFunction(
      "taskSpace",
      "console",
      closeTargetScript({ taskSpaceId: 7, targetId: "task-page" }),
    );
    await script(async () => task, { log: vi.fn() });
    expect(task.page).toHaveBeenCalledExactlyOnceWith("task-tab");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
