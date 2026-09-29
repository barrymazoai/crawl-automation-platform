import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FleetStatusFiles } from "./fleet-status-files.js";

const now = new Date("2026-09-29T12:00:00.000Z");

async function files(monitor: object | null, health: object | null) {
  const folder = await mkdtemp(join(tmpdir(), "fleet-status-"));
  const paths = {
    monitorStatus: join(folder, "status.json"),
    queueHealth: join(folder, "health.json"),
  };
  if (monitor) {
    await writeFile(paths.monitorStatus, JSON.stringify(monitor));
  }
  if (health) {
    await writeFile(paths.queueHealth, JSON.stringify(health));
  }
  return new FleetStatusFiles(paths, () => now);
}

describe("FleetStatusFiles", () => {
  it("reads workers and a fresh monitor", async () => {
    const source = await files(
      {
        at: "2026-09-29T11:59:55.000Z",
        jobs: [
          { id: "swanson-capture", ready: true },
          { id: "amazon-file", ready: false },
        ],
      },
      null,
    );

    await expect(source.fleet()).resolves.toEqual({
      checkedAt: "2026-09-29T11:59:55.000Z",
      monitorRunning: true,
      workers: [
        { id: "swanson-capture", ready: true },
        { id: "amazon-file", ready: false },
      ],
    });
  });

  it("reports a stale or stopped monitor as not running", async () => {
    const stale = await files({ at: "2026-09-29T11:50:00.000Z", jobs: [] }, null);
    const stopped = await files(
      { at: "2026-09-29T11:59:59.000Z", status: "monitor-stopped", jobs: [] },
      null,
    );

    expect((await stale.fleet()).monitorRunning).toBe(false);
    expect((await stopped.fleet()).monitorRunning).toBe(false);
  });

  it("reads queue health, and reports a missing file as unable to start", async () => {
    const healthy = await files(null, {
      at: "2026-09-29T11:59:58.000Z",
      canStart: true,
      reasons: [],
    });
    const missing = await files(null, null);

    await expect(healthy.queueHealth()).resolves.toMatchObject({ canStart: true, reasons: [] });
    await expect(missing.queueHealth()).resolves.toMatchObject({
      canStart: false,
      reasons: ["HEALTH_FILE_UNREADABLE"],
    });
  });
});
