import { FleetService } from "@crawl-automation/app";
import { describe, expect, it, vi } from "vitest";
import { appWith, post } from "../testing/app-with.js";

describe("fleet.status procedure", () => {
  it("returns the status service result with local jobs, remote pollers and OCR over GET", async () => {
    const service = new FleetService({
      jobs: { list: async () => [] },
      queueNames: ["browser"],
      taskQueues: {
        describe: async () => [
          {
            identity: "77@server-two",
            lastAccessTime: null,
            ratePerSecond: null,
          },
        ],
      },
      ocr: {
        health: async () => ({
          configured: false,
          healthy: false,
          statusCode: null,
          body: null,
          error: null,
        }),
      },
      now: () => 0,
    });
    const status = vi.spyOn(service, "status");
    const response = await appWith({ fleet: service }).request("/trpc/fleet.status");
    expect(response.status).toBe(200);
    expect(status).toHaveBeenCalledExactlyOnceWith();
    const result = (await response.json()).result.data;
    expect(result).toEqual(await status.mock.results[0]?.value);
    expect(result.taskQueues[0].pollers[0].identity).toBe("77@server-two");
    expect(result).not.toHaveProperty("monitorRunning");
  });

  it("is a query, not a job-control mutation", async () => {
    const status = vi.fn();
    const response = await appWith({ fleet: { status } }).request("/trpc/fleet.status", post({}));
    expect(response.status).toBe(405);
    expect(status).not.toHaveBeenCalled();
  });
});
