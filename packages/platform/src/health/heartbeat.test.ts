import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startHeartbeat } from "./heartbeat.js";

describe("startHeartbeat", () => {
  it("writes a running record the health monitor accepts, then a stopped one", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "heartbeat-")), "api.health.json");

    const heartbeat = await startHeartbeat(path, "api");
    const running = JSON.parse(await readFile(path, "utf8"));
    await heartbeat.stop();
    const stopped = JSON.parse(await readFile(path, "utf8"));

    expect(running).toMatchObject({ event: "WORKER_RUNNING", role: "api", pid: process.pid });
    expect(Date.now() - Date.parse(running.reportedAt)).toBeLessThan(15_000);
    expect(stopped).toMatchObject({ event: "WORKER_STOPPED", role: "api" });
  });

  it("refuses a relative path", async () => {
    await expect(startHeartbeat("api.health.json", "api")).rejects.toMatchObject({
      code: "HEALTH.PATH_NOT_ABSOLUTE",
    });
  });
});
