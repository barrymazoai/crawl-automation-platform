import { expect, it, vi } from "vitest";
import { createLogger } from "@crawl-automation/platform";
import { PostgresPermitStop } from "@crawl-automation/adapters";
import type { WorkerParts } from "../container.js";
import type { resourceActivities } from "../activities/resource-activities.js";
import { roleWorkers } from "./role-workers.js";
import { WORKER_ROLES } from "./process-config.js";

vi.mock("@temporalio/activity", () => ({
  Context: { current: () => ({ info: { activityId: "control", attempt: 1 } }) },
}));

it("registers the complete permit protocol together for every resource-serving role", async () => {
  const parts = {
    config: { browser: { resourceId: "mini-ego-space-1", pollLegacyQueue: false } },
    database: {},
    log: createLogger({ name: "test", level: "fatal" }),
  } as WorkerParts;
  const workers = roleWorkers(
    WORKER_ROLES.map((role) => ({ role, taskQueue: role, maxConcurrentActivities: 1 })),
    parts,
  );
  const serving = workers.filter((worker) => "reserveResources" in (worker.activities ?? {}));
  // All gated workflows address the dedicated resource queue, independent of their business role.
  expect(serving.map((worker) => worker.taskQueue)).toEqual(["resources"]);
  const verify = vi.spyOn(PostgresPermitStop.prototype, "verify").mockResolvedValue({
    permitId: "permit-test",
    state: "CLEANUP_UNVERIFIED",
    attempts: 1,
  });
  try {
    for (const worker of serving) {
      const activities = worker.activities as ReturnType<typeof resourceActivities>;
      expect(Object.keys(worker.activities ?? {}).sort()).toEqual([
        "prepareResourceExecution",
        "releaseResources",
        "reserveResources",
        "stopResourceExecution",
      ]);
      const request = { permitId: "permit-test", cleanupFailure: null };
      await expect(activities.stopResourceExecution(request)).resolves.toMatchObject({
        state: "CLEANUP_UNVERIFIED",
      });
      expect(verify).toHaveBeenCalledExactlyOnceWith(request);
    }
  } finally {
    verify.mockRestore();
  }
});
