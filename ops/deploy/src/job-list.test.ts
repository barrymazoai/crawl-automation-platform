import { describe, expect, it } from "vitest";
import { releaseJobs } from "./job-list.js";
import { MachineConfigSchema, MachineJobSchema } from "./machine-config.js";
import { serverOne } from "./testing.js";

const source = "/srv/crawler/releases/new/source";

describe("machine process definitions", () => {
  it("supplies release executable, arguments, cwd, environment and logs for each job", () => {
    const machine = serverOne();
    expect(releaseJobs(machine, source)).toEqual([
      {
        name: "collection-api",
        script: `${source}/apps/api/dist/main.js`,
        args: [],
        cwd: source,
        interpreter: "/opt/node",
        env: {
          V3_API_CONFIG: "/srv/private/api.json",
          V3_WORKER_HEALTH_FILE: "/srv/health/api.json",
        },
        outFile: "/srv/logs/api.out",
        errorFile: "/srv/logs/api.err",
      },
      {
        name: "pipeline-worker",
        script: `${source}/apps/worker/dist/main.js`,
        args: [],
        cwd: source,
        interpreter: "/opt/node",
        env: {
          V3_PIPELINE_CONFIG: "/srv/private/worker.json",
          V3_WORKER_PROCESS: "pipeline",
          V3_WORKER_HEALTH_FILE: "/srv/health/pipeline.json",
        },
        outFile: "/srv/logs/pipeline.out",
        errorFile: "/srv/logs/pipeline.err",
      },
    ]);
  });

  it.each(["V3_WORKER_PROCESS", "V3_WORKER_HEALTH_FILE"])(
    "rejects an environment override of %s",
    (name) => {
      const job = serverOne().jobs[1];
      expect(
        MachineJobSchema.safeParse({ ...job, env: { ...job?.env, [name]: "/override" } }).success,
      ).toBe(false);
    },
  );

  it("requires a matching config file and worker process", () => {
    const job = serverOne().jobs[1];
    expect(MachineJobSchema.safeParse({ ...job, process: undefined }).success).toBe(false);
    expect(MachineJobSchema.safeParse({ ...job, env: {} }).success).toBe(false);
  });

  it("requires unique names and health files, and refuses the old control-script config", () => {
    const machine = serverOne();
    expect(
      MachineConfigSchema.safeParse({ ...machine, jobs: [machine.jobs[0], machine.jobs[0]] })
        .success,
    ).toBe(false);
    expect(
      MachineConfigSchema.safeParse({
        ...machine,
        jobs: machine.jobs.map((job) => ({ ...job, healthFile: "/same" })),
      }).success,
    ).toBe(false);
    expect(
      MachineConfigSchema.safeParse({ ...machine, jobList: { control: "/manual-control.mjs" } })
        .success,
    ).toBe(false);
    expect(MachineJobSchema.safeParse({ ...machine.jobs[0], id: "all" }).success).toBe(false);
  });
});
