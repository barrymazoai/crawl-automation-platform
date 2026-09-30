import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { it, expect, vi, afterEach } from "vitest";
import { CodexRpc } from "./codex-rpc.js";

const state = vi.hoisted(() => ({ child: null as ChildProcessWithoutNullStreams | null }));
vi.mock("node:child_process", () => ({ spawn: () => state.child }));
afterEach(() => vi.useRealTimers());

function ownedConnection() {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
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
