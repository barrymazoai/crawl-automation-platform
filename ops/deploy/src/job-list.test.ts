import { describe, expect, it } from "vitest";
import { nextJobList, releaseJob } from "./job-list.js";
import { serverOne } from "./testing.js";

const source = "/srv/crawler/releases/new/source";
const machine = serverOne();
const [apiJob] = machine.jobs;
if (!apiJob) {
  throw new Error("the fixture machine runs the API");
}
const current = {
  platform: "darwin",
  host: "server-one",
  jobs: [
    releaseJob(apiJob, source),
    {
      id: "pipeline-worker",
      entry: "/srv/crawler/releases/old/source/apps/worker/dist/main.js",
      env: {},
    },
    { id: "amazon-ocr-7", entry: "/srv/crawler/releases/old/worker.js", env: {} },
  ],
  resources: [
    { resourceId: "mini-model", capacity: 10, jobs: ["amazon-ocr-7"], minFreeBytes: 0 },
    {
      resourceId: "scraperapi-lane",
      capacity: 40,
      jobs: ["pipeline-worker", "amazon-ocr-7"],
      minFreeBytes: 0,
    },
  ],
};

describe("next job list", () => {
  const change = nextJobList(current, machine, source);

  it("runs exactly the machine config's jobs from the new release", () => {
    expect(change.next.jobs.map((job) => job.id)).toEqual(["collection-api", "pipeline-worker"]);
    expect(change.next.jobs[1]).toEqual({
      id: "pipeline-worker",
      entry: `${source}/apps/worker/dist/main.js`,
      env: { V3_PIPELINE_CONFIG: "/srv/private/worker.json", V3_WORKER_PROCESS: "pipeline" },
    });
  });

  it("restarts only the jobs that start differently, and removes old-code jobs", () => {
    expect(change.changed).toEqual(["pipeline-worker"]);
    expect(change.removed).toEqual(["amazon-ocr-7"]);
  });

  it("stops resources naming removed jobs, and keeps the rest of the file", () => {
    expect(change.next.resources).toEqual([
      { resourceId: "scraperapi-lane", capacity: 40, jobs: ["pipeline-worker"], minFreeBytes: 0 },
    ]);
    expect(change.droppedResources).toBe(1);
    expect(change.next).toMatchObject({ platform: "darwin", host: "server-one" });
  });
});
