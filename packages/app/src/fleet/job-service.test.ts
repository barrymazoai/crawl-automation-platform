import { describe, expect, it, vi } from "vitest";
import { JobService } from "./job-service.js";
import type { JobDefinition, JobRunner, JobServicePorts } from "./job-ports.js";

function job(name: string, script = "/release/worker.js"): JobDefinition {
  return {
    name,
    script,
    args: [],
    cwd: "/release",
    interpreter: "/bin/node",
    env: { V3_WORKER_HEALTH_FILE: `/health/${name}.json` },
    outFile: `/logs/${name}.out`,
    errorFile: `/logs/${name}.err`,
  };
}

function fixture(previous: JobDefinition[] = []) {
  const events: string[] = [];
  const record = async (event: string) => {
    events.push(event);
  };
  const runner: JobRunner = {
    connect: vi.fn(() => record("connect")),
    disconnect: vi.fn(() => record("disconnect")),
    list: vi.fn(async () => previous.map((entry) => entry.name)),
    stop: vi.fn((name) => record(`stop:${name}`)),
    remove: vi.fn((name) => record(`remove:${name}`)),
    start: vi.fn(async (entry) => {
      await record(`start:${entry.name}`);
      return { pid: 123, startedAt: 1_000 };
    }),
    health: vi.fn(async (entry) => {
      await record(`health:${entry.name}`);
      return { name: entry.name, ready: true, reason: "ready" };
    }),
  };
  const ports: JobServicePorts = {
    runner,
    sleep: vi.fn(async () => undefined),
    file: {
      read: vi.fn(async () => previous),
      replace: vi.fn(async () => {
        await record("write");
        return { backup: "/backup.json" };
      }),
    },
  };
  return { events, ports, service: new JobService(ports) };
}

const request = (jobs: JobDefinition[]) => ({ jobs, health: { attempts: 2, intervalMs: 100 } });

describe("job service", () => {
  it("previews without connecting, writing or starting anything", async () => {
    const fake = fixture([job("removed")]);
    expect(await fake.service.preview(request([job("new")]))).toEqual({
      changed: ["new"],
      removed: ["removed"],
      unchanged: [],
    });
    expect(fake.events).toEqual([]);
  });

  it("writes first, retires all removed/changed jobs, starts changes, then waits for all jobs", async () => {
    const fake = fixture([job("removed"), job("changed", "/old.js"), job("same")]);
    const result = await fake.service.deploy(request([job("same"), job("changed"), job("new")]));
    expect(fake.events).toEqual([
      "connect",
      "write",
      "stop:removed",
      "remove:removed",
      "stop:changed",
      "remove:changed",
      "start:changed",
      "start:new",
      "health:same",
      "health:changed",
      "health:new",
      "disconnect",
    ]);
    expect(result).toMatchObject({
      backup: "/backup.json",
      written: true,
      phase: "complete",
      stopped: ["removed", "changed"],
      removedFromRunner: ["removed", "changed"],
      started: ["changed", "new"],
    });
    expect(fake.ports.runner.health).toHaveBeenCalledWith(job("new"), {
      pid: 123,
      startedAt: 1_000,
    });
    expect(fake.ports.runner.health).toHaveBeenCalledWith(job("same"), undefined);
  });

  it("leaves an unchanged definition untouched regardless of environment key order", async () => {
    const original = { ...job("same"), env: { FIRST: "one", SECOND: "two" } };
    const fake = fixture([original]);
    await fake.service.deploy(request([{ ...original, env: { SECOND: "two", FIRST: "one" } }]));
    expect(fake.ports.runner.start).not.toHaveBeenCalled();
    expect(fake.ports.runner.stop).not.toHaveBeenCalled();
    expect(fake.ports.runner.remove).not.toHaveBeenCalled();
  });

  it.each(["args", "cwd", "interpreter", "env", "outFile", "errorFile"] as const)(
    "detects a change in %s",
    async (field) => {
      const original = job("changed");
      const changed = {
        ...original,
        [field]: field === "args" ? ["--flag"] : field === "env" ? { KEY: "new" } : "/new",
      };
      const fake = fixture([original]);
      expect((await fake.service.preview(request([changed]))).changed).toEqual(["changed"]);
    },
  );

  it("does not restart an unchanged job that has crashed", async () => {
    const fake = fixture([job("crashed")]);
    fake.ports.runner.health = vi.fn(async () => ({
      name: "crashed",
      ready: false,
      reason: "stopped",
    }));
    await expect(fake.service.deploy(request([job("crashed")]))).rejects.toMatchObject({
      code: "JOBS.APPLY_FAILED",
      details: { phase: "health", failure: { code: "JOBS.UNHEALTHY" } },
    });
    expect(fake.ports.runner.start).not.toHaveBeenCalled();
    expect(fake.ports.runner.health).toHaveBeenCalledTimes(2);
    expect(fake.ports.sleep).toHaveBeenCalledTimes(1);
  });

  it("fails before writing when a new name belongs to an unrelated process", async () => {
    const fake = fixture();
    fake.ports.runner.list = vi.fn(async () => ["unrelated"]);
    await expect(fake.service.deploy(request([job("unrelated")]))).rejects.toMatchObject({
      details: { phase: "inventory", written: false, failure: { code: "JOBS.NAME_CONFLICT" } },
    });
    expect(fake.events).toEqual(["connect", "disconnect"]);
  });

  it.each(["connect", "write", "stop", "remove", "start"])(
    "reports partial progress at %s and never retries the failed operation",
    async (phase) => {
      const fake = fixture([job("old")]);
      const failure = new Error(`failed ${phase}`);
      const fail = vi.fn().mockRejectedValue(failure);
      if (phase === "write") {
        fake.ports.file.replace = fail;
      } else {
        fake.ports.runner[phase as "connect" | "stop" | "remove" | "start"] = fail;
      }
      await expect(fake.service.deploy(request([job("new")]))).rejects.toMatchObject({
        cause: failure,
        details: { phase, started: [], failure: { message: `Error: failed ${phase}` } },
      });
      expect(fail).toHaveBeenCalledTimes(1);
      expect(fake.events.at(-1)).toBe("disconnect");
      expect(fake.ports.runner.health).not.toHaveBeenCalled();
    },
  );

  it("reports a successful earlier start when a later start fails; no rollback or retry", async () => {
    const fake = fixture();
    fake.ports.runner.start = vi
      .fn()
      .mockResolvedValueOnce({ pid: 123, startedAt: 1_000 })
      .mockRejectedValueOnce(new Error("second"));
    await expect(
      fake.service.deploy(request([job("first"), job("second"), job("third")])),
    ).rejects.toMatchObject({
      details: { phase: "start", job: "second", written: true, started: ["first"] },
    });
    expect(fake.ports.runner.start).toHaveBeenCalledTimes(2);
    expect(fake.ports.runner.stop).not.toHaveBeenCalled();
  });

  it("preserves both the original failure and a disconnect failure", async () => {
    const fake = fixture();
    fake.ports.runner.start = vi.fn().mockRejectedValue(new Error("start failed"));
    fake.ports.runner.disconnect = vi.fn().mockRejectedValue(new Error("disconnect failed"));
    await expect(fake.service.deploy(request([job("new")]))).rejects.toMatchObject({
      details: {
        phase: "start",
        failure: {
          errors: [{ message: "Error: start failed" }, { message: "Error: disconnect failed" }],
        },
      },
    });
  });

  it("does not mistake a rejection with no error payload for success", async () => {
    const fake = fixture();
    fake.ports.runner.start = vi.fn().mockRejectedValue(undefined);
    await expect(fake.service.deploy(request([job("new")]))).rejects.toMatchObject({
      code: "JOBS.APPLY_FAILED",
      details: { phase: "start", failure: { message: "undefined" } },
    });
  });

  it("rejects duplicate names and invalid polling before any I/O", async () => {
    const fake = fixture();
    await expect(fake.service.preview(request([job("same"), job("same")]))).rejects.toMatchObject({
      code: "JOBS.INVALID_PLAN",
    });
    await expect(
      fake.service.deploy({ jobs: [], health: { attempts: 0, intervalMs: 1 } }),
    ).rejects.toMatchObject({ code: "JOBS.INVALID_PLAN" });
    expect(fake.ports.file.read).not.toHaveBeenCalled();
  });
});
