import { JobService } from "@crawl-automation/app";
import { describe, expect, it, vi } from "vitest";
import { ecosystemApp } from "./ecosystem.js";
import { Pm2JobRunner } from "./job-runner.js";
import { exampleJob, FakePm2, STARTED } from "./testing.js";

function fixture() {
  const client = new FakePm2();
  const runner = new Pm2JobRunner({
    client: async () => client,
    now: () => STARTED,
    prepare: async () => undefined,
    readHealth: async () => null,
  });
  return { client, runner };
}

describe("PM2 job runner", () => {
  it("applies service ordering over fake PM2 while leaving unchanged and unrelated jobs untouched", async () => {
    const client = new FakePm2();
    const previous = [
      exampleJob("same"),
      { ...exampleJob("changed"), script: "/old.js" },
      exampleJob("removed"),
    ];
    for (const job of [...previous, exampleJob("unrelated")]) {
      client.start(ecosystemApp(job), () => undefined);
    }
    client.events.length = 0;
    let now = STARTED;
    const runner = new Pm2JobRunner({
      client: async () => client,
      now: () => now,
      prepare: async () => undefined,
      readHealth: async (path) => {
        now = STARTED + 2_000;
        const process = [...client.processes.values()].find(
          (entry) => path === `/health/${entry.name}.json`,
        );
        return JSON.stringify({
          event: "WORKER_RUNNING",
          role: "pipeline-worker",
          pid: process?.pid,
          reportedAt: new Date(STARTED + 1_000).toISOString(),
        });
      },
    });
    const service = new JobService({
      runner,
      sleep: vi.fn(),
      file: {
        read: async () => previous,
        replace: async () => {
          client.events.push("write");
          return { backup: "/backup.json" };
        },
      },
    });
    await service.deploy({
      jobs: [exampleJob("same"), exampleJob("changed"), exampleJob("new")],
      health: { attempts: 1, intervalMs: 1 },
    });
    expect(client.events.filter((event) => !/^(describe:|list)/.test(event))).toEqual([
      "connect",
      "write",
      "stop:removed",
      "delete:removed",
      "stop:changed",
      "delete:changed",
      "start:changed",
      "start:new",
      "disconnect",
    ]);
    expect(client.processes.get("same")?.pid).toBe(101);
    expect(client.processes.get("unrelated")?.pid).toBe(104);
  });

  it("connects, starts exactly the ecosystem options, describes, stops, deletes and disconnects", async () => {
    const { client, runner } = fixture();
    const job = exampleJob();
    await runner.connect();
    expect(await runner.start(job)).toEqual({ pid: 101, startedAt: STARTED });
    expect(await runner.list()).toEqual([job.name]);
    await runner.stop(job.name);
    await runner.remove(job.name);
    await runner.disconnect();
    expect(client.starts).toEqual([ecosystemApp(job)]);
    expect(client.events).toEqual([
      "connect",
      `describe:${job.name}`,
      `start:${job.name}`,
      `describe:${job.name}`,
      "list",
      `describe:${job.name}`,
      `stop:${job.name}`,
      `describe:${job.name}`,
      `describe:${job.name}`,
      `delete:${job.name}`,
      `describe:${job.name}`,
      "disconnect",
    ]);
  });

  it("treats an absent process as stopped and removed without sending broad commands", async () => {
    const { client, runner } = fixture();
    await runner.connect();
    await runner.stop("absent");
    await runner.remove("absent");
    expect(client.events).toEqual(["connect", "describe:absent", "describe:absent"]);
  });

  it("refuses duplicate starts and deletion of a running process", async () => {
    const { runner } = fixture();
    await runner.connect();
    await runner.start(exampleJob());
    await expect(runner.start(exampleJob())).rejects.toMatchObject({
      code: "PM2.PROCESS_CONFLICT",
    });
    await expect(runner.remove(exampleJob().name)).rejects.toMatchObject({
      code: "PM2.PROCESS_CONFLICT",
    });
  });

  it("does not accept a stop receipt while describe still reports a live PID", async () => {
    const { client, runner } = fixture();
    await runner.connect();
    await runner.start(exampleJob());
    vi.spyOn(client, "stop").mockImplementation((_id, callback) => callback(null));
    await expect(runner.stop(exampleJob().name)).rejects.toMatchObject({
      code: "PM2.PROCESS_CONFLICT",
    });
    expect(client.events).not.toContain(`delete:${exampleJob().name}`);
  });

  it("rejects an ambiguous name instead of stopping either process", async () => {
    const { client, runner } = fixture();
    await runner.connect();
    vi.spyOn(client, "describe").mockImplementation((name, callback) =>
      callback(null, [
        { name, pm_id: 1 },
        { name, pm_id: 2 },
      ]),
    );
    await expect(runner.stop("duplicate")).rejects.toMatchObject({ code: "PM2.PROCESS_CONFLICT" });
    expect(client.events).toEqual(["connect"]);
  });

  it("disconnects after failed connection and keeps the actual PM2 reason", async () => {
    const { client, runner } = fixture();
    vi.spyOn(client, "connect").mockImplementation((callback) =>
      callback(new Error("daemon unavailable")),
    );
    const service = new JobService({
      runner,
      file: { read: async () => [], replace: vi.fn() },
      sleep: vi.fn(),
    });
    await expect(
      service.deploy({ jobs: [exampleJob()], health: { attempts: 1, intervalMs: 1 } }),
    ).rejects.toMatchObject({
      details: {
        phase: "connect",
        failure: {
          code: "PM2.OPERATION_FAILED",
          details: { reason: "daemon unavailable" },
        },
      },
    });
    expect(client.events).toEqual(["disconnect"]);
  });

  it("reports partial deployment through the real adapter over fake PM2", async () => {
    const { client, runner } = fixture();
    const start = client.start.bind(client);
    vi.spyOn(client, "start").mockImplementation((options, callback) => {
      if (options.name === "second") {
        callback(new Error("spawn refused"));
      } else {
        start(options, callback);
      }
    });
    const service = new JobService({
      runner,
      sleep: vi.fn(),
      file: { read: async () => [], replace: async () => ({ backup: null }) },
    });
    await expect(
      service.deploy({
        jobs: [exampleJob("first"), exampleJob("second"), exampleJob("third")],
        health: { attempts: 1, intervalMs: 1 },
      }),
    ).rejects.toMatchObject({
      details: {
        phase: "start",
        job: "second",
        started: ["first"],
        failure: {
          code: "PM2.OPERATION_FAILED",
          details: { operation: "start second", reason: "spawn refused" },
        },
      },
    });
    expect([...client.processes.keys()]).toEqual(["first"]);
    expect(client.events.at(-1)).toBe("disconnect");
  });
});
