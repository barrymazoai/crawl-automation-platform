import { describe, expect, it, vi } from "vitest";
import { FleetService } from "./fleet-service.js";
import type {
  FleetJobObservation,
  FleetStatusPorts,
  OcrHealth,
  WorkerHeartbeat,
} from "./status-ports.js";

const NOW = Date.parse("2026-09-30T10:00:00Z");
const at = (age: number) => new Date(NOW - age).toISOString();
const ocr: OcrHealth = {
  configured: true,
  healthy: true,
  statusCode: 200,
  body: { status: "ok", healthy_backends: 4, total_backends: 4 },
  error: null,
};

function job(): FleetJobObservation & { heartbeat: WorkerHeartbeat } {
  return {
    name: "collection-pipeline",
    status: "online",
    pid: 123,
    restarts: 2,
    startedAt: NOW - 60_000,
    process: "pipeline",
    queues: ["pipeline", "resources"],
    heartbeat: { process: "pipeline", pid: 123, running: true, lastHeartbeat: at(1_000) },
    issues: [],
  } satisfies FleetJobObservation;
}

function fixture(jobs: FleetJobObservation[] = [job()]) {
  const ports: FleetStatusPorts = {
    jobs: { list: vi.fn(async () => jobs) },
    taskQueues: {
      describe: vi.fn(async () => [
        { identity: "77@server-two", lastAccessTime: at(100), ratePerSecond: 100 },
      ]),
    },
    queueNames: ["browser", "pipeline", "browser"],
    ocr: { health: vi.fn(async () => ocr) },
    now: () => NOW,
  };
  return { ports, service: new FleetService(ports) };
}

describe("fleet status", () => {
  it("reports PM2 runtime, the actual heartbeat, remote pollers, and OCR", async () => {
    const fake = fixture();
    const result = await fake.service.status();
    expect(result.checkedAt).toBe(at(0));
    expect(result.local).toEqual({
      error: null,
      jobs: [
        {
          name: "collection-pipeline",
          status: "online",
          pid: 123,
          restarts: 2,
          startedAt: NOW - 60_000,
          uptimeMs: 60_000,
          issues: [],
          health: {
            process: "pipeline",
            queues: ["pipeline", "resources"],
            pid: 123,
            running: true,
            lastHeartbeat: at(1_000),
            stale: false,
            ready: true,
            reason: "ready",
          },
        },
      ],
    });
    expect(result.ocr).toEqual(ocr);
    expect(result.taskQueues).toHaveLength(6);
    for (const name of ["browser", "pipeline", "resources"]) {
      for (const kind of ["workflow", "activity"]) {
        expect(fake.ports.taskQueues.describe).toHaveBeenCalledWith(name, kind);
      }
    }
    expect(result.taskQueues[0]?.pollers[0]?.identity).toBe("77@server-two");
    expect(result).not.toHaveProperty("monitorRunning");
    expect(result).not.toHaveProperty("queue");
  });

  it.each([
    [14_999, false],
    [15_000, false],
    [15_001, true],
  ])("a heartbeat aged %d ms is stale=%s", async (age, stale) => {
    const entry = job();
    entry.heartbeat = { ...entry.heartbeat, lastHeartbeat: at(Number(age)) };
    const result = await fixture([entry]).service.status();
    expect(result.local.jobs[0]?.health).toMatchObject({ stale, ready: !stale });
  });

  it.each([
    [{ pid: 321 }, "health-identity-mismatch"],
    [{ process: "other" }, "health-identity-mismatch"],
    [{ running: false }, "worker-stopped"],
    [{ lastHeartbeat: at(-1) }, "health-outside-start-window"],
  ])("does not report an invalid heartbeat as ready: %j", async (changes, reason) => {
    const entry = job();
    entry.heartbeat = { ...entry.heartbeat, ...changes };
    const result = await fixture([entry]).service.status();
    expect(result.local.jobs[0]?.health).toMatchObject({ ready: false, reason });
  });

  it("rejects evidence from before this PM2 incarnation", async () => {
    const entry = { ...job(), startedAt: NOW - 500 };
    const result = await fixture([entry]).service.status();
    expect(result.local.jobs[0]?.health.reason).toBe("health-outside-start-window");
  });

  it("retains stopped jobs even with fresh leftover heartbeats", async () => {
    const entry = { ...job(), status: "stopped", pid: 0 };
    const result = await fixture([entry]).service.status();
    expect(result.local.jobs[0]).toMatchObject({
      uptimeMs: 0,
      health: { ready: false, reason: "process-not-running", running: true },
    });
  });

  it("represents missing heartbeat evidence without claiming the worker stopped", async () => {
    const result = await fixture([{ ...job(), heartbeat: null }]).service.status();
    expect(result.local.jobs[0]?.health).toMatchObject({
      running: null,
      lastHeartbeat: null,
      stale: true,
      ready: false,
    });
  });

  it("keeps pollers and OCR visible when PM2 is unavailable", async () => {
    const fake = fixture();
    fake.ports.jobs.list = vi.fn().mockRejectedValue(
      Object.assign(new Error("offline"), {
        code: "PM2.DAEMON_REQUIRED",
      }),
    );
    const result = await fake.service.status();
    expect(result.local).toEqual({
      jobs: [],
      error: { code: "PM2.DAEMON_REQUIRED", message: "offline" },
    });
    expect(result.taskQueues).toHaveLength(4);
    expect(result.ocr.healthy).toBe(true);
  });

  it("keeps an empty poller list distinct from a failed describe", async () => {
    const fake = fixture([]);
    fake.ports.taskQueues.describe = vi.fn(async (_name, kind) => {
      if (kind === "activity") {
        throw Object.assign(new Error("unavailable"), { code: 14 });
      }
      return [];
    });
    const result = await fake.service.status();
    expect(result.taskQueues[0]).toMatchObject({ pollers: [], error: null });
    expect(result.taskQueues[1]).toMatchObject({
      pollers: [],
      error: { code: 14, message: "unavailable" },
    });
  });

  it("preserves the other sources and the actual OCR failure", async () => {
    const fake = fixture();
    fake.ports.ocr.health = vi.fn().mockRejectedValue(new Error("request timed out"));
    const result = await fake.service.status();
    expect(result.ocr).toMatchObject({ healthy: false, error: { message: "request timed out" } });
    expect(result.local.jobs).toHaveLength(1);
    expect(result.taskQueues).toHaveLength(6);
  });
});
