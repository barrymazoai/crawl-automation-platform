import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { it, expect, vi, afterEach } from "vitest";
import { CodexRpc } from "./codex-rpc.js";
import { withPermitExecution, type PermitExecutionLedger } from "../execution/permit-execution.js";

const state = vi.hoisted(() => ({ child: null as ChildProcessWithoutNullStreams | null }));
vi.mock("node:child_process", () => ({ spawn: () => state.child }));
afterEach(() => vi.useRealTimers());

function ownedConnection() {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    pid: 1245,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  state.child = child as unknown as ChildProcessWithoutNullStreams;
  const rpc = new CodexRpc({ executable: "unused", args: [], cwd: process.cwd(), env: {} });
  return { child, rpc };
}

it("SIGKILL alone is not close proof; await actual close", async () => {
  const { child, rpc } = ownedConnection();
  let done = false;
  const pending = rpc.close().then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(1001);
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  expect(done).toBe(false);
  child.emit("close");
  await pending;
  expect(done).toBe(true);
});

it("fails closed when no close arrives after escalation", async () => {
  const { rpc } = ownedConnection();
  const checked = expect(rpc.close()).rejects.toThrow("TEXT.CODEX_STOP_UNCONFIRMED");
  await vi.advanceTimersByTimeAsync(6001);
  await checked;
});

it("records the exact Codex process before work and proves stop only after child close", async () => {
  const { child, rpc } = ownedConnection();
  const ledger = {
    record: vi.fn<PermitExecutionLedger["record"]>(async () => undefined),
    prove: vi.fn<PermitExecutionLedger["prove"]>(async () => undefined),
  };
  const owner = { permitId: "permit-one", workflowId: "workflow", runId: "run" };
  vi.spyOn(rpc, "request").mockResolvedValue({});
  await withPermitExecution({ owner, ledger }, async () => {
    await rpc.initialize(new AbortController().signal);
    expect(ledger.record).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({
        kind: "codex",
        pid: 1245,
        host: expect.any(String),
        startedAt: expect.any(String),
      }),
    );
    const closed = rpc.close({ proveStopped: true });
    await vi.advanceTimersByTimeAsync(1001);
    expect(ledger.prove).not.toHaveBeenCalled();
    child.emit("close");
    await closed;
    expect(ledger.prove).toHaveBeenCalledWith(
      owner,
      ledger.record.mock.calls[0]?.[1],
      expect.objectContaining({ kind: "process-exit" }),
    );
  });
});
