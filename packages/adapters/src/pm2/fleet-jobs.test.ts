import type { ProcessDescription } from "pm2";
import { describe, expect, it, vi } from "vitest";
import { Pm2FleetJobs } from "./fleet-jobs.js";
import { Pm2FleetFiles } from "./fleet-health.js";
import { FakePm2 } from "./testing.js";

const heartbeat = {
  event: "WORKER_RUNNING",
  role: "pipeline-worker",
  pid: 100,
  reportedAt: "2026-09-30T10:00:00Z",
};

function fixture() {
  const client = new FakePm2();
  const environment = {
    status: "online" as const,
    restart_time: 3,
    pm_uptime: 1_000,
    pm_cwd: "/release",
    V3_WORKER_PROCESS: "pipeline",
    V3_WORKER_CONFIG: "worker.json",
    V3_WORKER_HEALTH_FILE: "/health/pipeline.json",
    PRIVATE_KEY: "never-expose",
  };
  client.processes.set("pipeline", { name: "pipeline", pid: 100, pm2_env: environment });
  const config = {
    processes: {
      pipeline: { roles: [{ taskQueue: "products" }, { taskQueue: "resources" }] },
      model: { roles: [{ taskQueue: "models" }] },
    },
    credentials: { password: "never-expose" },
  };
  const bytes: Record<string, string> = {
    "/health/pipeline.json": JSON.stringify(heartbeat),
    "/release/worker.json": JSON.stringify(config),
  };
  const read = vi.fn(async (path: string) => bytes[path] ?? null);
  const source = new Pm2FleetJobs({
    client: async () => client,
    files: new Pm2FleetFiles({ read }),
  });
  return { client, source, read, bytes };
}

describe("PM2 fleet observations", () => {
  it("lists every local job, projects queues and heartbeat, and never exposes private settings", async () => {
    const fake = fixture();
    fake.client.processes.set("other", { name: "other", pid: 0, pm2_env: { status: "stopped" } });
    const jobs = await fake.source.list();
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      name: "pipeline",
      status: "online",
      pid: 100,
      restarts: 3,
      startedAt: 1_000,
      process: "pipeline",
      queues: ["products", "resources"],
      issues: [],
      heartbeat: {
        process: "pipeline",
        pid: 100,
        running: true,
        lastHeartbeat: heartbeat.reportedAt,
      },
    });
    expect(jobs[1]).toMatchObject({ name: "other", status: "stopped", pid: 0, heartbeat: null });
    expect(JSON.stringify(jobs)).not.toContain("never-expose");
    expect(fake.read.mock.calls.map(([path]) => path).sort()).toEqual([
      "/health/pipeline.json",
      "/release/worker.json",
    ]);
    expect(fake.client.events).toEqual(["connect", "list", "disconnect"]);
  });

  it.each([null, "{", JSON.stringify({ role: "pipeline" })])(
    "retains the job when its health file is absent or corrupt: %s",
    async (bytes) => {
      const fake = fixture();
      fake.bytes["/health/pipeline.json"] = bytes ?? "null";
      const [entry] = await fake.source.list();
      expect(entry).toMatchObject({
        name: "pipeline",
        heartbeat: null,
        queues: ["products", "resources"],
      });
      expect(entry?.issues).toHaveLength(1);
    },
  );

  it("retains a stopped heartbeat", async () => {
    const fake = fixture();
    fake.bytes["/health/pipeline.json"] = JSON.stringify({ ...heartbeat, event: "WORKER_STOPPED" });
    expect((await fake.source.list())[0]?.heartbeat?.running).toBe(false);
  });

  it("records a filesystem failure without losing runtime or other jobs", async () => {
    const fake = fixture();
    fake.read.mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    const [entry] = await fake.source.list();
    expect(entry?.pid).toBe(100);
    expect(entry?.issues).toEqual([{ code: "EACCES", message: "permission denied" }]);
  });

  it("supports the single pipeline queue in worker configs without process groups", async () => {
    const fake = fixture();
    fake.bytes["/release/worker.json"] = JSON.stringify({ taskQueue: "products" });
    expect((await fake.source.list())[0]?.queues).toEqual(["products"]);
  });

  it("records corrupt worker settings while retaining valid heartbeat evidence", async () => {
    const fake = fixture();
    fake.bytes["/release/worker.json"] = "{";
    const [entry] = await fake.source.list();
    expect(entry?.heartbeat?.running).toBe(true);
    expect(entry?.queues).toEqual([]);
    expect(entry?.issues).toHaveLength(1);
  });

  it("coalesces overlapping reads and disconnects once, then refreshes on the next call", async () => {
    const fake = fixture();
    const [first, second] = await Promise.all([fake.source.list(), fake.source.list()]);
    expect(first).toBe(second);
    expect(fake.client.events).toEqual(["connect", "list", "disconnect"]);
    await fake.source.list();
    expect(fake.client.events.filter((event) => event === "list")).toHaveLength(2);
  });

  it("disconnects after a failed list without starting, stopping or retrying jobs", async () => {
    const fake = fixture();
    fake.client.list = (callback) => callback(new Error("list failed"));
    await expect(fake.source.list()).rejects.toMatchObject({ code: "PM2.OPERATION_FAILED" });
    expect(fake.client.events).toEqual(["connect", "disconnect"]);
  });

  it("propagates the manual-daemon rejection without opening a new PM2 instance", async () => {
    const client = vi.fn().mockRejectedValue(new Error("manual daemon required"));
    await expect(new Pm2FleetJobs({ client }).list()).rejects.toThrow("manual daemon required");
    expect(client).toHaveBeenCalledOnce();
  });

  it("does not drop unnamed PM2 jobs", async () => {
    const fake = fixture();
    fake.client.processes.set("unnamed", {} satisfies ProcessDescription);
    expect((await fake.source.list())[1]).toMatchObject({ name: null, status: "unknown" });
  });

  it("retains every job when an unrelated job has malformed environment metadata", async () => {
    const fake = fixture();
    const environment = { status: "stopped" as const, V3_WORKER_PROCESS: 123 };
    fake.client.processes.set("bad", { name: "bad", pm2_env: environment });
    const jobs = await fake.source.list();
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.heartbeat?.running).toBe(true);
    expect(jobs[1]?.issues.length).toBeGreaterThan(0);
  });
});
