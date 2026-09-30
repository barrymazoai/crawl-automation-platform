import { describe, expect, it } from "vitest";
import type { WorkerConfig } from "../config.js";
import { checkWorkerRoleSettings } from "./role-settings.js";

/** Presence checks only: each section's contents are validated separately by WorkerConfigSchema. */
function pipelineSettings(section: string): WorkerConfig {
  return {
    capture: {},
    label: {},
    plan: {},
    [section]: undefined,
    processes: { pipeline: { roles: [{ role: "pipeline" }] } },
  } as unknown as WorkerConfig;
}

describe("role section requirements", () => {
  it.each(["capture", "label", "plan"])("refuses pipeline without %s", (section) => {
    expect(() => checkWorkerRoleSettings(pipelineSettings(section))).toThrow(
      expect.objectContaining({
        code: "WORKER.ROLE_SETTINGS_MISSING",
        details: { role: "pipeline", section },
      }),
    );
  });

  it("checks every role in a grouped process, including pipeline beside browser", () => {
    const config = pipelineSettings("label");
    config.processes = {
      browser: {
        roles: [
          { role: "browser", taskQueue: "browser", maxConcurrentActivities: 1 },
          { role: "pipeline", taskQueue: "pipeline", maxConcurrentActivities: 1 },
        ],
      },
    };
    expect(() => checkWorkerRoleSettings(config)).toThrow(
      expect.objectContaining({ details: { role: "pipeline", section: "label" } }),
    );
  });
});
