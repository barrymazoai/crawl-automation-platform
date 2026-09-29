import { Writable } from "node:stream";
import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { appErrors } from "../errors.js";
import {
  settledOutcome,
  type DispatchStore,
  type QueueControl,
  type RunExecution,
  type SettledOutcome,
  type StartedItem,
} from "./dispatch-model.js";
import { QueueDispatcher } from "./queue-dispatcher.js";

const silent = createLogger({
  name: "test",
  destination: new Writable({ write: (_chunk, _encoding, done) => done() }),
});
const signal = () => new AbortController().signal;

function item(runId: string, stopRequested = false): StartedItem {
  const url = `https://www.swansonvitamins.com/p/${runId}`;
  return {
    itemId: `item-${runId}`,
    channel: "swanson",
    runId,
    sourceId: "source-1",
    url,
    stopRequested,
  };
}

/** A queue with one channel: its running items, the items a claim returns, and what was settled. */
class FakeDispatch implements DispatchStore {
  control: QueueControl = { channel: "swanson", mode: "running", readyLimit: 5, runningLimit: 2 };
  runningItems: StartedItem[] = [];
  claimable: StartedItem[] = [];
  settled: { runId: string; outcome: SettledOutcome }[] = [];
  stopMarked: string[] = [];
  pausedIfIdle = 0;
  filled = 0;

  controls = async () => [this.control];
  running = async () => this.runningItems;
  fillReady = async () => {
    this.filled++;
  };
  claim = async () => this.claimable.splice(0);
  settle = async (started: StartedItem, outcome: SettledOutcome) => {
    this.settled.push({ runId: started.runId, outcome });
  };
  markStopRequested = async (started: StartedItem) => {
    this.stopMarked.push(started.runId);
  };
  pauseIfIdle = async () => {
    this.pausedIfIdle++;
  };
}

function dispatcher(executions: Record<string, RunExecution>, paused = false) {
  const store = new FakeDispatch();
  const starter = { submit: vi.fn(async (run: { requestId: string }) => run.requestId) };
  const canceller = { cancel: vi.fn(async () => undefined) };
  const lookup = async (runId: string) => executions[runId] ?? { status: "MISSING", result: null };
  const deps = { store, executions: { execution: lookup }, starter, canceller, log: silent };
  const queue = new QueueDispatcher({ ...deps, isPaused: async () => paused }, { intervalMs: 500 });
  return { store, starter, canceller, queue };
}

describe("settledOutcome", () => {
  it.each([
    [
      { status: "COMPLETED", result: { status: "collected" } },
      { state: "completed", reason: null },
    ],
    [
      { status: "COMPLETED", result: { status: "review", code: "SOURCE.GONE" } },
      { state: "review", reason: "SOURCE.GONE" },
    ],
    [
      { status: "COMPLETED", result: { status: "listing", state: "unlisted" } },
      { state: "completed", reason: null },
    ],
    [
      { status: "COMPLETED", result: { status: "odd" } },
      { state: "review", reason: "QUEUE.OUTCOME_UNRECOGNIZED" },
    ],
    [
      { status: "TIMED_OUT", result: null },
      { state: "review", reason: "QUEUE.RUN_TIMED_OUT" },
    ],
    [
      { status: "CANCELLED", result: null },
      { state: "review", reason: "QUEUE.RUN_CANCELLED" },
    ],
    [{ status: "RUNNING", result: null }, null],
    [{ status: "MISSING", result: null }, null],
  ])("%j ends as %j", (execution, expected) => {
    expect(settledOutcome(execution)).toEqual(expected);
  });
});

describe("QueueDispatcher", () => {
  it("settles ended runs, then fills ready and starts claimed items once each", async () => {
    const { store, starter, queue } = dispatcher({
      done: { status: "COMPLETED", result: { status: "collected" } },
      busy: { status: "RUNNING", result: null },
    });
    store.runningItems = [item("done"), item("busy")];
    store.claimable = [item("new-1")];
    await queue.tick(signal());
    expect(store.settled).toEqual([
      { runId: "done", outcome: { state: "completed", reason: null } },
    ]);
    expect(store.filled).toBe(1);
    expect(starter.submit).toHaveBeenCalledTimes(1);
    expect(starter.submit).toHaveBeenCalledWith({
      kind: "product",
      requestId: "new-1",
      sourceId: "source-1",
      url: "https://www.swansonvitamins.com/p/new-1",
    });
  });

  it("a refused start is a Review with the refusal's code, never started again", async () => {
    const { store, starter, queue } = dispatcher({});
    starter.submit.mockRejectedValueOnce(appErrors.create("RUN.CHANNEL_UNSUPPORTED"));
    store.claimable = [item("refused")];
    await queue.tick(signal());
    expect(store.settled).toEqual([
      { runId: "refused", outcome: { state: "review", reason: "RUN.CHANNEL_UNSUPPORTED" } },
    ]);
  });

  it("an unconfirmed start stays running and the next round finishes the same start", async () => {
    const { store, starter, queue } = dispatcher({});
    starter.submit.mockRejectedValueOnce(new Error("deadline exceeded"));
    store.claimable = [item("unsure")];
    await queue.tick(signal());
    expect(store.settled).toEqual([]);
    store.runningItems = [item("unsure")];
    await queue.tick(signal());
    expect(starter.submit).toHaveBeenCalledTimes(2);
    expect(starter.submit.mock.calls.map(([run]) => run.requestId)).toEqual(["unsure", "unsure"]);
  });

  it("the pause file stops new starts but running items still settle", async () => {
    const { store, starter, queue } = dispatcher(
      { done: { status: "FAILED", result: null } },
      true,
    );
    store.runningItems = [item("done")];
    store.claimable = [item("waiting")];
    await queue.tick(signal());
    expect(store.settled).toEqual([
      { runId: "done", outcome: { state: "review", reason: "QUEUE.RUN_FAILED" } },
    ]);
    expect(starter.submit).not.toHaveBeenCalled();
  });

  it("a draining channel starts nothing and pauses once idle", async () => {
    const { store, starter, queue } = dispatcher({});
    store.control = { ...store.control, mode: "draining" };
    store.claimable = [item("waiting")];
    await queue.tick(signal());
    expect(starter.submit).not.toHaveBeenCalled();
    expect(store.pausedIfIdle).toBe(1);
  });

  it("a forced stop cancels each running run once, and an unstarted item is settled without starting", async () => {
    const running = { status: "RUNNING", result: null };
    const { store, starter, canceller, queue } = dispatcher({ busy: running, asked: running });
    store.control = { ...store.control, mode: "stopping" };
    store.runningItems = [item("busy"), item("asked", true), item("never-started")];
    await queue.tick(signal());
    expect(canceller.cancel).toHaveBeenCalledTimes(1);
    expect(canceller.cancel).toHaveBeenCalledWith("busy");
    expect(store.stopMarked).toEqual(["busy"]);
    expect(starter.submit).not.toHaveBeenCalled();
    expect(store.settled).toEqual([
      {
        runId: "never-started",
        outcome: { state: "review", reason: "QUEUE.STOPPED_BEFORE_START" },
      },
    ]);
  });
});
