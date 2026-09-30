import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runMachineJobs } from "./job-health.js";
import { serverOne } from "./testing.js";

it("previews a first machine deployment through the real composition without initializing PM2 or writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crawler-deploy-preview-"));
  try {
    const lines: string[] = [];
    const machine = serverOne({
      pm2: {
        file: join(directory, "ecosystem.json"),
        backups: join(directory, "backups"),
      },
    });
    await runMachineJobs(machine, "/release", { dryRun: true, print: (line) => lines.push(line) });
    expect(lines).toContain("  changed: collection-api, pipeline-worker");
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
