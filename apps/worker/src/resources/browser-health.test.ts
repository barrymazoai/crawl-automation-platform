import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceHealthMonitor } from "@crawl-automation/app";
import { createLogger, EgoSettingsSchema, EGO_MARKER } from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import type { CoreParts } from "../core-parts.js";
import { browserHealthReason, reserveWithBrowserHealth } from "./browser-health.js";

it("Ego down gates admission without a permit, writes unhealthy, and the monitor heals on the next probe", async () => {
  const folder = await mkdtemp(join(tmpdir(), "browser-admission-"));
  const cliPath = join(folder, "ego-browser");
  const response = join(folder, "response");
  await writeFile(
    cliPath,
    `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => console.log(require('node:fs').readFileSync(${JSON.stringify(response)}, 'utf8')));`,
  );
  await chmod(cliPath, 0o755);
  const setHealth = async (code: string | null) =>
    writeFile(response, EGO_MARKER + JSON.stringify({ kind: "health", code, targets: [] }));
  const query = vi.fn(async () => [{}]);
  const config = {
    browser: { ego: EgoSettingsSchema.parse({ cliPath, taskSpaceId: 6 }) },
    resourceKinds: { "server2-ego-space-6": "browser" },
    resourceHealth: {
      controller: "this-host",
      ttlMs: 15_000,
      resources: { "server2-ego-space-6": { taskQueues: ["browser"] } },
    },
  };
  const parts = { config, database: { query } } as unknown as CoreParts;
  const raw = {
    permitId: "permit-one",
    workflowId: "scan-one",
    runId: "00000000-0000-4000-8000-000000000001",
    needs: [{ resourceId: "server2-ego-space-6", units: 1 }],
  };
  let healthy = false;
  let grants = 0;
  const reserve = vi.fn(async () => {
    if (!healthy) {
      return { status: "waiting", reason: "browser:BROWSER.UNAVAILABLE" };
    }
    grants++;
    return { status: "granted" };
  });
  const signal = new AbortController().signal;
  try {
    await setHealth("BROWSER.UNAVAILABLE");
    expect(await reserveWithBrowserHealth({ parts, raw, signal, reserve })).toMatchObject({
      status: "waiting",
      reason: "browser:BROWSER.UNAVAILABLE",
    });
    expect(reserve).toHaveBeenCalledOnce();
    expect(grants).toBe(0);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE resource_capacity"), [
      "server2-ego-space-6",
      false,
      "browser:BROWSER.UNAVAILABLE",
      "this-host",
      15_000,
    ]);
    const write = vi.fn(async () => 1);
    const monitor = new ResourceHealthMonitor(
      {
        browser: { reason: () => browserHealthReason(parts, signal) },
        repository: { write },
        taskQueues: {
          describe: vi.fn(async () => [
            { identity: "poller", lastAccessTime: null, ratePerSecond: null },
          ]),
        },
        disk: { freeBytes: async () => 1000 },
        ocr: { health: vi.fn() },
        log: createLogger({ name: "test", level: "fatal" }),
      },
      {
        controller: "this-host",
        intervalMs: 5000,
        ttlMs: 15000,
        minFreeBytes: 0,
        diskPath: folder,
        resources: { "server2-ego-space-6": { taskQueues: ["browser"], browser: true } },
      },
    );
    await monitor.tick(signal);
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({ healthy: false, reason: "browser:BROWSER.UNAVAILABLE" }),
    );
    await setHealth(null);
    healthy = true;
    await monitor.tick(signal);
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({ healthy: true, reason: "ready" }),
    );
    expect(await reserveWithBrowserHealth({ parts, raw, signal, reserve })).toEqual({
      status: "granted",
    });
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(grants).toBe(1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
