import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import type { ResourceHealthOptions, ResourceHealthPorts } from "./health-ports.js";
import { ResourceHealthMonitor } from "./resource-health.js";

function fixture(
  resources: ResourceHealthOptions["resources"] = { cpu: { taskQueues: ["label"] } },
) {
  const options = {
    controller: '["test-host","/test/root"]',
    intervalMs: 5,
    ttlMs: 15_000,
    minFreeBytes: 1_000,
    diskPath: "/test/root",
    resources,
  };
  const lines: Record<string, unknown>[] = [];
  const deps = {
    repository: { write: vi.fn<ResourceHealthPorts["repository"]["write"]>().mockResolvedValue(1) },
    taskQueues: {
      describe: vi
        .fn<ResourceHealthPorts["taskQueues"]["describe"]>()
        .mockResolvedValue([
          { identity: "worker", lastAccessTime: new Date().toISOString(), ratePerSecond: null },
        ]),
    },
    ocr: {
      health: vi.fn<ResourceHealthPorts["ocr"]["health"]>().mockResolvedValue({
        configured: true,
        healthy: true,
        statusCode: 200,
        body: {},
        error: null,
      }),
    },
    disk: { freeBytes: vi.fn(async () => 1_000) },
    log: createLogger({
      name: "health-test",
      destination: {
        write: (line) => {
          lines.push(JSON.parse(line));
        },
      },
    }),
  };
  const controller = new AbortController();
  const monitor = new ResourceHealthMonitor(deps, options);
  return { deps, options, lines, monitor, controller, tick: () => monitor.tick(controller.signal) };
}

describe("resource health", () => {
  it("requires all activity queues, OCR when requested and enough available disk", async () => {
    const { deps, tick } = fixture({ ocr: { taskQueues: ["label", "ocr"], ocr: true } });
    await tick();
    expect(deps.taskQueues.describe.mock.calls).toEqual([
      ["label", "activity"],
      ["ocr", "activity"],
    ]);
    expect(deps.ocr.health).toHaveBeenCalledOnce();
    expect(deps.disk.freeBytes).toHaveBeenCalledWith("/test/root");
    expect(deps.repository.write).toHaveBeenCalledWith({
      resourceId: "ocr",
      controller: '["test-host","/test/root"]',
      healthy: true,
      reason: "ready",
      ttlMs: 15_000,
    });
  });

  it("skips OCR for a resource that does not require it", async () => {
    const { deps, tick } = fixture();
    deps.ocr.health.mockRejectedValue(new Error("offline"));
    await tick();
    expect(deps.ocr.health).not.toHaveBeenCalled();
    expect(deps.repository.write).toHaveBeenCalledWith(expect.objectContaining({ healthy: true }));
  });

  it("names the first missing queue before checking OCR or disk", async () => {
    const { deps, tick } = fixture({
      cpu: { taskQueues: ["first", "second", "third"], ocr: true },
    });
    deps.taskQueues.describe.mockResolvedValueOnce([
      { identity: "worker", lastAccessTime: null, ratePerSecond: null },
    ]);
    deps.taskQueues.describe.mockResolvedValue([]);
    await tick();
    expect(deps.repository.write).toHaveBeenCalledWith(
      expect.objectContaining({ healthy: false, reason: "no_pollers:second" }),
    );
    expect(deps.taskQueues.describe).toHaveBeenCalledTimes(2);
    expect(deps.ocr.health).not.toHaveBeenCalled();
    expect(deps.disk.freeBytes).not.toHaveBeenCalled();
  });

  it("reports OCR before low disk, and low disk after healthy OCR", async () => {
    const { deps, tick } = fixture({ ocr: { taskQueues: ["ocr"], ocr: true } });
    deps.ocr.health.mockResolvedValueOnce({
      configured: true,
      healthy: false,
      statusCode: 503,
      body: null,
      error: null,
    });
    deps.disk.freeBytes.mockResolvedValue(999);
    await tick();
    expect(deps.repository.write).toHaveBeenLastCalledWith(
      expect.objectContaining({ healthy: false, reason: "ocr_unhealthy" }),
    );
    expect(deps.disk.freeBytes).not.toHaveBeenCalled();
    await tick();
    expect(deps.repository.write).toHaveBeenLastCalledWith(
      expect.objectContaining({ healthy: false, reason: "disk_low" }),
    );
  });

  it("isolates a throwing queue probe to its resource and keeps the original error", async () => {
    const { deps, tick, lines } = fixture({
      broken: { taskQueues: ["missing"] },
      cpu: { taskQueues: ["label"] },
    });
    deps.taskQueues.describe.mockRejectedValueOnce(new Error("describe unavailable"));
    await tick();
    expect(deps.repository.write).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: "broken",
        reason: "no_pollers:missing",
        healthy: false,
      }),
    );
    expect(deps.repository.write).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "cpu", healthy: true }),
    );
    expect(lines).toEqual([
      expect.objectContaining({
        code: "RESOURCE_HEALTH.PROBE_FAILED",
        resourceId: "broken",
        err: expect.objectContaining({ message: "describe unavailable" }),
      }),
    ]);
  });

  it.each(["ocr", "disk"] as const)("marks a throwing %s probe unhealthy", async (probe) => {
    const { deps, tick, lines } = fixture({ cpu: { taskQueues: ["label"], ocr: true } });
    if (probe === "ocr") {
      deps.ocr.health.mockRejectedValue(new Error("OCR unreachable"));
    } else {
      deps.disk.freeBytes.mockRejectedValue(new Error("statfs denied"));
    }
    await tick();
    expect(deps.repository.write).toHaveBeenCalledWith(
      expect.objectContaining({
        healthy: false,
        reason: probe === "ocr" ? "ocr_unhealthy" : "disk_low",
      }),
    );
    expect(lines[0]).toMatchObject({ code: "RESOURCE_HEALTH.PROBE_FAILED" });
  });

  it("logs failures returned by the shared OCR probe", async () => {
    const { deps, tick, lines } = fixture({ ocr: { taskQueues: ["ocr"], ocr: true } });
    deps.ocr.health.mockResolvedValue({
      configured: true,
      healthy: false,
      statusCode: null,
      body: null,
      error: { code: null, message: "fetch failed" },
    });
    await tick();
    expect(lines[0]).toMatchObject({
      code: "RESOURCE_HEALTH.PROBE_FAILED",
      reason: "ocr_unhealthy",
    });
    expect(JSON.stringify(lines)).toContain("fetch failed");
  });

  it("warns on zero matched rows and continues after a write failure", async () => {
    const { deps, tick, lines } = fixture({
      missing: { taskQueues: ["label"] },
      broken: { taskQueues: ["label"] },
      cpu: { taskQueues: ["label"] },
    });
    deps.repository.write
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error("database unavailable"));
    await tick();
    expect(deps.repository.write).toHaveBeenCalledTimes(3);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RESOURCE_HEALTH.CONTROLLER_MISMATCH",
          resourceId: "missing",
        }),
        expect.objectContaining({ code: "RESOURCE_HEALTH.WRITE_FAILED", resourceId: "broken" }),
      ]),
    );
  });

  it("refreshes immediately and periodically, then invalidates every configured row on abort", async () => {
    const { deps, monitor, controller } = fixture();
    const running = monitor.run(controller.signal);
    await vi.waitFor(() => expect(deps.repository.write.mock.calls.length).toBeGreaterThan(1));
    controller.abort();
    await running;
    expect(deps.repository.write).toHaveBeenLastCalledWith({
      resourceId: "cpu",
      controller: '["test-host","/test/root"]',
      healthy: false,
      reason: "monitor_stopping",
      ttlMs: 0,
    });
    const writes = deps.repository.write.mock.calls.length;
    await monitor.tick(controller.signal);
    expect(deps.repository.write).toHaveBeenCalledTimes(writes);
  });

  it("never publishes ready when a pending probe completes during shutdown", async () => {
    const { deps, monitor, controller } = fixture();
    let finish: (bytes: number) => void = () => undefined;
    deps.disk.freeBytes.mockReturnValue(
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
    );
    const running = monitor.run(controller.signal);
    await vi.waitFor(() => expect(deps.disk.freeBytes).toHaveBeenCalledOnce());
    controller.abort();
    finish(10_000);
    await running;
    expect(deps.repository.write.mock.calls.map(([state]) => state.reason)).toEqual([
      "monitor_stopping",
    ]);
  });

  it("attempts every stop write even if one fails", async () => {
    const { deps, monitor, controller, lines } = fixture({
      cpu: { taskQueues: ["label"] },
      model: { taskQueues: ["model"] },
    });
    controller.abort();
    deps.repository.write.mockRejectedValueOnce(new Error("connection lost"));
    await monitor.run(controller.signal);
    expect(
      deps.repository.write.mock.calls.map(([state]) => [
        state.resourceId,
        state.reason,
        state.ttlMs,
      ]),
    ).toEqual([
      ["cpu", "monitor_stopping", 0],
      ["model", "monitor_stopping", 0],
    ]);
    expect(lines[0]).toMatchObject({
      code: "RESOURCE_HEALTH.WRITE_FAILED",
      reason: "monitor_stopping",
    });
    expect(deps.taskQueues.describe).not.toHaveBeenCalled();
  });
});
