import { describe, expect, it } from "vitest";
import { jobHealth, type HealthObservation } from "./job-health.js";
import { Pm2JobRunner } from "./job-runner.js";
import { exampleJob, FakePm2, STARTED } from "./testing.js";

const heartbeat = {
  role: "pipeline-worker",
  event: "WORKER_RUNNING",
  pid: 123,
  reportedAt: new Date(STARTED + 1_000).toISOString(),
};
const observation = (): HealthObservation => ({
  job: exampleJob(),
  process: { name: exampleJob().name, pid: 123, pm2_env: { status: "online", pm_uptime: STARTED } },
  start: { pid: 123, startedAt: STARTED },
  now: STARTED + 2_000,
  bytes: JSON.stringify(heartbeat),
});

describe("PM2 health evidence", () => {
  it("accepts only a running process with matching fresh evidence after its start", () => {
    expect(jobHealth(observation())).toMatchObject({ ready: true });
  });

  it.each([
    ["wrong PID", { pid: 999 }],
    ["wrong process", { role: "vision-worker" }],
    ["stopped event", { event: "WORKER_STOPPED" }],
    ["before this start", { reportedAt: new Date(STARTED - 1).toISOString() }],
    ["at this start", { reportedAt: new Date(STARTED).toISOString() }],
    ["in the future", { reportedAt: new Date(STARTED + 3_000).toISOString() }],
    ["invalid timestamp", { reportedAt: "not a date" }],
  ])("rejects %s", (_label, changes) => {
    expect(
      jobHealth({ ...observation(), bytes: JSON.stringify({ ...heartbeat, ...changes }) }).ready,
    ).toBe(false);
  });

  it.each([15_000, 15_001, 60_000])("rejects a heartbeat aged %d ms", (age) => {
    expect(jobHealth({ ...observation(), now: STARTED + 1_000 + age }).ready).toBe(false);
  });

  it.each([null, "broken JSON", "{}"])("rejects missing or malformed health: %s", (bytes) => {
    expect(jobHealth({ ...observation(), bytes }).ready).toBe(false);
  });

  it.each(["stopped", "errored", "launching"] as const)(
    "rejects PM2 status %s even with fresh health",
    (status) => {
      const input = observation();
      input.process = { ...input.process, pm2_env: { status, pm_uptime: STARTED } };
      expect(jobHealth(input).ready).toBe(false);
    },
  );

  it("rejects a PID or start-time change after the start receipt", () => {
    expect(jobHealth({ ...observation(), start: { pid: 456, startedAt: STARTED } }).ready).toBe(
      false,
    );
    expect(jobHealth({ ...observation(), start: { pid: 123, startedAt: STARTED - 1 } }).ready).toBe(
      false,
    );
  });

  it("checks unchanged jobs against their PM2 start and accepts the API role", () => {
    const { start: _start, ...input } = observation();
    input.job = {
      ...exampleJob("api"),
      env: { V3_API_CONFIG: "/api.json", V3_WORKER_HEALTH_FILE: "/api-health.json" },
    };
    input.bytes = JSON.stringify({ ...heartbeat, role: "api" });
    expect(jobHealth(input).ready).toBe(true);
    input.bytes = JSON.stringify({
      ...heartbeat,
      role: "api",
      reportedAt: new Date(STARTED - 1).toISOString(),
    });
    expect(jobHealth(input).ready).toBe(false);
  });

  it("reads the configured file and matches the actual PID returned by fake PM2", async () => {
    const client = new FakePm2();
    client.processes.set(exampleJob().name, {
      name: exampleJob().name,
      pid: 123,
      pm2_env: { status: "online", pm_uptime: STARTED },
    });
    const runner = new Pm2JobRunner({
      client: async () => client,
      now: () => STARTED + 2_000,
      readHealth: async (path) => {
        expect(path).toBe(exampleJob().env.V3_WORKER_HEALTH_FILE);
        return JSON.stringify(heartbeat);
      },
    });
    await runner.connect();
    expect((await runner.health(exampleJob())).ready).toBe(true);
    await runner.disconnect();
  });
});
