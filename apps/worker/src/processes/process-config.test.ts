import { describe, expect, it } from "vitest";
import type { WorkerConfig } from "../config.js";
import { WorkerProcessesSchema } from "./process-config.js";
import { selectProcess } from "./select-process.js";

/** The parts of a worker config process selection reads. */
function configWith(parts: Pick<WorkerConfig, "processes" | "taskQueue">): WorkerConfig {
  return { maxConcurrentActivities: 4, ...parts } as WorkerConfig;
}

const grouped = WorkerProcessesSchema.parse({
  pipeline: { roles: [{ role: "pipeline", taskQueue: "v3.pipeline.product.v1" }] },
});

describe("worker processes", () => {
  it("runs a config written before processes existed as the pipeline on its task queue", () => {
    const chosen = selectProcess(configWith({ taskQueue: "v3.pipeline.product.v1" }), undefined);
    expect(chosen).toEqual({
      name: "pipeline",
      roles: [
        { role: "pipeline", taskQueue: "v3.pipeline.product.v1", maxConcurrentActivities: 4 },
      ],
    });
  });

  it("runs the roles the named process groups, with their limits", () => {
    const chosen = selectProcess(configWith({ processes: grouped }), "pipeline");
    expect(chosen.roles).toEqual([
      { role: "pipeline", taskQueue: "v3.pipeline.product.v1", maxConcurrentActivities: 4 },
    ]);
  });

  it("refuses a process the machine config does not name", () => {
    expect(() => selectProcess(configWith({ processes: grouped }), "label-vision")).toThrow(
      expect.objectContaining({ code: "WORKER.UNKNOWN_PROCESS" }),
    );
    expect(() => selectProcess(configWith({ taskQueue: "q" }), "label-text")).toThrow(
      expect.objectContaining({ code: "WORKER.UNKNOWN_PROCESS" }),
    );
  });

  it.each([
    ["an unknown role", { pipeline: { roles: [{ role: "label-teleport", taskQueue: "q" }] } }],
    ["a role twice", { pipeline: { roles: [role("q1"), role("q2")] } }],
    ["no roles", { pipeline: { roles: [] } }],
    ["no processes", {}],
    ["a process name that is not lower-case words", { Pipeline: { roles: [role("q")] } }],
  ])("refuses %s", (_case, processes) => {
    expect(WorkerProcessesSchema.safeParse(processes).success).toBe(false);
  });
});

function role(taskQueue: string) {
  return { role: "pipeline", taskQueue };
}
