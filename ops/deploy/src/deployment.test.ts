import { describe, expect, it } from "vitest";
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
    expect(fake.lines.join("\n")).toContain("git clone --no-checkout git@example.test:crawler.git");
    expect(fake.lines.join("\n")).toContain("removed (old code, stopped): amazon-ocr-7");
    expect(fake.lines.at(-1)).toBe("Dry run: nothing was changed.");
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
