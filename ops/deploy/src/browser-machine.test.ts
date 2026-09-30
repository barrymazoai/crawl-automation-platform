import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pm2ProcessFile } from "@crawl-automation/adapters";
import { describe, expect, it } from "vitest";
import { deployPlan, releaseSource } from "./deploy-plan.js";
import { Deployment } from "./deployment.js";
import { releaseJobs } from "./job-list.js";
import { COMMIT, fakeMachine, serverOne } from "./testing.js";

const machine = serverOne({
  machine: "server-two",
  migrations: undefined,
  jobs: [
    {
      id: "browser-worker",
      app: "worker",
      process: "browser",
      env: { V3_PIPELINE_CONFIG: "/srv/private/browser-worker.json" },
      healthFile: "/srv/health/browser.json",
      logs: { out: "/srv/logs/browser.out", error: "/srv/logs/browser.err" },
    },
  ],
});
const source = releaseSource(machine, COMMIT);

describe("Server 二 browser-only deployment", () => {
  it("writes a manual-start ecosystem with the browser process, settings, health and logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-ecosystem-"));
    try {
      const file = join(root, "ecosystem.json");
      const writer = new Pm2ProcessFile({ file, backups: join(root, "backups") });
      expect(await writer.read()).toEqual([]);
      await writer.replace(releaseJobs(machine, source));
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        apps: [
          {
            name: "browser-worker",
            script: `${source}/apps/worker/dist/main.js`,
            args: [],
            cwd: source,
            interpreter: "/opt/node",
            env: {
              V3_PIPELINE_CONFIG: "/srv/private/browser-worker.json",
              V3_WORKER_PROCESS: "browser",
              V3_WORKER_HEALTH_FILE: "/srv/health/browser.json",
            },
            out_file: "/srv/logs/browser.out",
            error_file: "/srv/logs/browser.err",
            autorestart: false,
            watch: false,
            exec_mode: "fork",
            instances: 1,
          },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds only worker and deploys without an API, migration settings or migration credentials", async () => {
    const steps = deployPlan(machine, { commit: COMMIT, migrate: false });
    expect(steps.map((step) => step.title)).toEqual([
      "Check the release directory is new",
      "Clone origin",
      "Check the commit is on main",
      "Check out the commit",
      "Install locked dependencies",
      "Build worker",
      "Write the PM2 file, replace changed jobs and wait for ready",
    ]);
    const fake = fakeMachine();
    fake.ports.env = () => undefined;
    await new Deployment(machine, fake.ports, { commit: COMMIT, dryRun: false }).run(steps);
    expect(fake.migrations).toEqual([]);
    expect(fake.commands).toContain("/opt/pnpm --filter @crawl-automation/worker build");
    expect(fake.commands.slice(-3)).toEqual(["connect", "start browser-worker", "disconnect"]);
    expect(fake.writes.at(-1)?.value).toEqual(releaseJobs(machine, source));
    expect(fake.lines.at(-1)).toBe("Deployed.");
  });
});
