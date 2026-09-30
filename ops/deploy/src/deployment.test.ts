import { describe, expect, it, vi } from "vitest";
import { deployErrors } from "./deploy-errors.js";
import { deployPlan } from "./deploy-plan.js";
import { Deployment } from "./deployment.js";
import { releaseJobs } from "./job-list.js";
import { COMMIT, fakeMachine, serverOne } from "./testing.js";

const machine = serverOne();
const oldJobs = releaseJobs(machine, "/srv/old");
const source = `/srv/crawler/releases/${COMMIT}/source`;

async function deploy(
  options: { dryRun: boolean; migrate?: boolean },
  fake = fakeMachine(oldJobs),
) {
  const steps = deployPlan(machine, { commit: COMMIT, migrate: options.migrate ?? false });
  await new Deployment(machine, fake.ports, { commit: COMMIT, dryRun: options.dryRun }).run(steps);
  return fake;
}

describe("deployment", () => {
  it("prints a dry run without commands, writes, migrations or a PM2 connection", async () => {
    const fake = await deploy({ dryRun: true, migrate: true });
    expect(fake.commands).toEqual([]);
    expect(fake.writes).toEqual([]);
    expect(fake.migrations).toEqual([]);
    expect(fake.lines.join("\n")).toContain("git clone --no-checkout git@example.test:crawler.git");
    expect(fake.lines.join("\n")).toContain('"changed":["collection-api","pipeline-worker"]');
    expect(fake.lines.at(-1)).toBe("Dry run: nothing was changed.");
  });

  it("runs the in-process migration against release SQL before any process-file switch", async () => {
    const fake = fakeMachine(oldJobs);
    const migrate = fake.ports.migrate;
    fake.ports.migrate = async (release, settings) => {
      expect(fake.writes).toEqual([]);
      expect(fake.commands).not.toContain("connect");
      await migrate(release, settings);
    };
    await deploy({ dryRun: false, migrate: true }, fake);
    expect(fake.migrations).toEqual([{ source, settings: machine.migrations }]);
    expect(fake.commands.some((command) => command.includes("v3-api"))).toBe(false);
  });

  it("stops before writing or connecting to PM2 if migration fails", async () => {
    const fake = fakeMachine(oldJobs);
    const failure = deployErrors.create("DEPLOY.COMMAND_FAILED");
    fake.ports.migrate = vi.fn().mockRejectedValue(failure);
    await expect(deploy({ dryRun: false, migrate: true }, fake)).rejects.toBe(failure);
    expect(fake.writes).toEqual([]);
    expect(fake.commands).not.toContain("connect");
  });

  it("backs up and replaces through the job service; all stops precede all starts", async () => {
    const fake = await deploy({ dryRun: false });
    expect(fake.writes.map((write) => write.path)).toEqual([
      "/srv/crawler/manual-releases/previous.json",
      "/srv/crawler/live/ecosystem.json",
    ]);
    expect(fake.writes[0]?.value).toEqual(oldJobs);
    expect(fake.commands.slice(-8)).toEqual([
      "connect",
      "stop collection-api",
      "remove collection-api",
      "stop pipeline-worker",
      "remove pipeline-worker",
      "start collection-api",
      "start pipeline-worker",
      "disconnect",
    ]);
    expect(fake.commands.join("\n")).not.toMatch(/manual-control|pm2 startup|pm2 save/);
  });

  it("does not restart unchanged jobs", async () => {
    const fake = await deploy({ dryRun: false }, fakeMachine(releaseJobs(machine, source)));
    expect(fake.commands.filter((line) => /^(stop|start|remove) /.test(line))).toEqual([]);
  });

  it("refuses an existing release before running any command", async () => {
    const fake = fakeMachine(oldJobs);
    fake.existing.add(source);
    await expect(deploy({ dryRun: false }, fake)).rejects.toMatchObject({
      code: "DEPLOY.RELEASE_EXISTS",
    });
    expect(fake.commands).toEqual([]);
  });

  it("surfaces an unhealthy job with partial progress and never reports deployment success", async () => {
    const fake = fakeMachine(oldJobs, (name) => name !== "pipeline-worker");
    await expect(deploy({ dryRun: false }, fake)).rejects.toMatchObject({
      code: "JOBS.APPLY_FAILED",
      details: {
        phase: "health",
        started: ["collection-api", "pipeline-worker"],
        failure: {
          code: "JOBS.UNHEALTHY",
          details: {
            health: expect.arrayContaining([
              { name: "pipeline-worker", ready: false, reason: "stopped" },
            ]),
          },
        },
      },
    });
    expect(fake.lines).not.toContain("Deployed.");
  });
});
