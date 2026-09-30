import { describe, expect, it, vi } from "vitest";
import { deployErrors } from "./deploy-errors.js";
import { deployPlan } from "./deploy-plan.js";
import { Deployment } from "./deployment.js";
import { releaseJob } from "./job-list.js";
import { COMMIT, fakeMachine, serverOne } from "./testing.js";

const machine = serverOne();
const oldList = {
  jobs: [
    {
      id: "collection-api",
      entry: "/srv/crawler/releases/old/source/apps/api/dist/main.js",
      env: {},
    },
    { id: "amazon-ocr-7", entry: "/srv/crawler/releases/old/worker.js", env: {} },
  ],
  resources: [],
};

async function deploy(
  options: { dryRun: boolean; migrate?: boolean },
  fake = fakeMachine(oldList),
) {
  const steps = deployPlan(machine, { commit: COMMIT, migrate: options.migrate ?? false });
  await new Deployment(machine, fake.ports, { commit: COMMIT, dryRun: options.dryRun }).run(steps);
  return fake;
}

describe("deployment", () => {
  it("in a dry run prints every step and changes nothing", async () => {
    const fake = await deploy({ dryRun: true, migrate: true });
    expect(fake.commands).toEqual([]);
    expect(fake.writes).toEqual([]);
    expect(fake.migrations).toEqual([]);
    expect(fake.lines.join("\n")).toContain("git clone --no-checkout git@example.test:crawler.git");
    expect(fake.lines.join("\n")).toContain("removed (old code, stopped): amazon-ocr-7");
    expect(fake.lines.at(-1)).toBe("Dry run: nothing was changed.");
  });

  it("uses one in-process migration of the release before switching jobs", async () => {
    const fake = fakeMachine(oldList);
    const migrate = fake.ports.migrate;
    fake.ports.migrate = async (source, settings) => {
      expect(fake.writes).toEqual([]);
      await migrate(source, settings);
    };
    await deploy({ dryRun: false, migrate: true }, fake);
    expect(fake.migrations).toEqual([
      {
        source: `/srv/crawler/releases/${COMMIT}/source`,
        settings: machine.migrations,
      },
    ]);
    expect(fake.commands.some((command) => command.includes("v3-api"))).toBe(false);
  });

  it("a migration failure stops before any job-list write or job restart", async () => {
    const fake = fakeMachine(oldList);
    const failure = deployErrors.create("DEPLOY.COMMAND_FAILED");
    fake.ports.migrate = vi.fn().mockRejectedValue(failure);
    await expect(deploy({ dryRun: false, migrate: true }, fake)).rejects.toBe(failure);
    expect(fake.writes).toEqual([]);
    expect(fake.commands.some((command) => command.startsWith("/opt/node"))).toBe(false);
  });

  it("backs up the job list before writing the new one, then restarts only changed jobs", async () => {
    const fake = await deploy({ dryRun: false });
    expect(fake.writes.map((write) => write.path)).toEqual([
      "/srv/crawler/manual-releases/deployment.before-68adac2a1b2c-20260930T010203.json",
      "/srv/crawler/live/deployment.json",
    ]);
    expect(fake.writes[0]?.value).toEqual(oldList);
    const control = fake.commands.filter((line) => line.startsWith("/opt/node"));
    expect(control.slice(0, 5)).toEqual([
      "/opt/node /srv/crawler/manual-control.mjs stop amazon-ocr-7",
      "/opt/node /srv/crawler/manual-control.mjs stop collection-api",
      "/opt/node /srv/crawler/manual-control.mjs start collection-api",
      "/opt/node /srv/crawler/manual-control.mjs stop pipeline-worker",
      "/opt/node /srv/crawler/manual-control.mjs start pipeline-worker",
    ]);
  });

  it("does not restart a job whose release entry is unchanged", async () => {
    const source = `/srv/crawler/releases/${COMMIT}/source`;
    const same = { jobs: machine.jobs.map((job) => releaseJob(job, source)), resources: [] };
    const fake = await deploy({ dryRun: false }, fakeMachine(same));
    expect(fake.commands.filter((line) => / (stop|start) /.test(line))).toEqual([]);
  });

  it("refuses to reuse an existing release directory", async () => {
    const fake = fakeMachine(oldList);
    fake.existing.add(`/srv/crawler/releases/${COMMIT}/source`);
    await expect(deploy({ dryRun: false }, fake)).rejects.toMatchObject({
      code: "DEPLOY.RELEASE_EXISTS",
    });
    expect(fake.commands).toEqual([]);
  });

  it("stops when a job never becomes healthy", async () => {
    const fake = fakeMachine(oldList, (id) => id !== "pipeline-worker");
    await expect(deploy({ dryRun: false }, fake)).rejects.toMatchObject({
      code: "DEPLOY.UNHEALTHY",
    });
  });
});
