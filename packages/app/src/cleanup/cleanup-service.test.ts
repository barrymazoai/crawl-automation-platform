import { Writable } from "node:stream";
import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { CleanupService } from "./cleanup-service.js";

function setup(intervalMs = 1) {
  const resources = { releaseStopped: vi.fn(async () => ({ released: ["permit"], kept: 2 })) };
  const runs = {
    settleStopped: vi.fn(async () =>
      ["run-one", "run-two"].map((runId) => ({
        runId,
        permitsReleased: 0,
        guardReleased: true,
      })),
    ),
  };
  const log = createLogger({
    name: "cleanup-test",
    destination: new Writable({ write: (_chunk, _encoding, done) => done() }),
  });
  const error = vi.spyOn(log, "error");
  return {
    resources,
    runs,
    error,
    service: new CleanupService({ resources, runs, log, intervalMs }),
  };
}

describe("CleanupService.sweep", () => {
  it("releases stopped permits before settling runs and counts only completed work", async () => {
    const { service, resources, runs } = setup();
    await expect(service.sweep()).resolves.toEqual({ permitsReleased: 1, runsSettled: 2 });
    expect(resources.releaseStopped).toHaveBeenCalledOnce();
    expect(runs.settleStopped).toHaveBeenCalledOnce();
    expect(resources.releaseStopped.mock.invocationCallOrder[0]).toBeLessThan(
      runs.settleStopped.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("reports an empty sweep without counting retained permits", async () => {
    const { service, resources, runs } = setup();
    resources.releaseStopped.mockResolvedValue({ released: [], kept: 5 });
    runs.settleStopped.mockResolvedValue([]);
    await expect(service.sweep()).resolves.toEqual({ permitsReleased: 0, runsSettled: 0 });
  });

  it("propagates release failures and never settles runs after an unverified release", async () => {
    const { service, resources, runs } = setup();
    const failure = new Error("release unavailable");
    resources.releaseStopped.mockRejectedValue(failure);
    await expect(service.sweep()).rejects.toBe(failure);
    expect(runs.settleStopped).not.toHaveBeenCalled();
  });

  it("propagates settlement failures without repeating resource release", async () => {
    const { service, resources, runs } = setup();
    const failure = new Error("settlement unavailable");
    runs.settleStopped.mockRejectedValue(failure);
    await expect(service.sweep()).rejects.toBe(failure);
    expect(resources.releaseStopped).toHaveBeenCalledOnce();
  });
});

describe("CleanupService.run", () => {
  it("does nothing for an already aborted signal", async () => {
    const { service, resources } = setup();
    await service.run(AbortSignal.abort());
    expect(resources.releaseStopped).not.toHaveBeenCalled();
  });

  it("logs a failed sweep, continues, then stops when aborted during a sweep", async () => {
    const { service, resources, runs, error } = setup();
    const controller = new AbortController();
    const failure = new Error("temporary failure");
    resources.releaseStopped.mockRejectedValueOnce(failure);
    runs.settleStopped.mockImplementation(async () => {
      controller.abort();
      return [];
    });
    await service.run(controller.signal);
    expect(resources.releaseStopped).toHaveBeenCalledTimes(2);
    expect(runs.settleStopped).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledExactlyOnceWith(
      { err: failure, code: null },
      "cleanup sweep failed",
    );
  });

  it("aborts an idle delay without another sweep or a spurious error", async () => {
    const { service, runs, resources, error } = setup(60_000);
    const controller = new AbortController();
    const running = service.run(controller.signal);
    await vi.waitFor(() => expect(runs.settleStopped).toHaveBeenCalled(), { interval: 1 });
    controller.abort();
    await running;
    expect(resources.releaseStopped).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });
});
