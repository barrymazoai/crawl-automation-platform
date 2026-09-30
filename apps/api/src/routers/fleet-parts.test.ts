import { Pm2FleetJobs } from "@crawl-automation/adapters";
import { createLogger, type TemporalClient } from "@crawl-automation/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiConfigSchema } from "../config.js";
import { assembleContainer } from "../container.js";
import productionShaped from "../fixtures/api-config.json" with { type: "json" };
import { fleetQueueNames } from "./fleet-parts.js";
import { FleetOcrHealth } from "./fleet-ocr.js";

afterEach(() => vi.restoreAllMocks());

describe("fleet composition", () => {
  it("derives routed queues, resource queues and remote browser queues, plus explicit extras", () => {
    const config = ApiConfigSchema.parse({
      ...productionShaped,
      fleet: { taskQueues: ["label-ocr", "label-model", "pipeline"] },
    });
    config.pipeline.channels.gnc = {
      resources: { queue: "resources", maxWaitSeconds: 900, activities: {} },
    };
    expect(fleetQueueNames(config)).toEqual([
      "label-ocr",
      "label-model",
      "pipeline",
      "label",
      "browser",
      "v3.pipeline.product.v1",
      "resources",
    ]);
  });

  it("does not describe the unconfigured pipeline placeholder", () => {
    const config = ApiConfigSchema.parse({ ...productionShaped, pipeline: undefined });
    expect(fleetQueueNames(config)).not.toContain("none");
  });

  it("accepts OCR settings through their existing schema and validates new queue settings", () => {
    const fleet = { ocrApi: { baseUrl: "https://ocr.example.test", provider: "paddle/1" } };
    expect(ApiConfigSchema.parse({ ...productionShaped, fleet }).fleet.ocrApi?.timeoutMs).toBe(
      45_000,
    );
    for (const invalid of [
      { taskQueues: [""] },
      { ocrApi: { baseUrl: "bad", provider: "paddle/1" } },
    ]) {
      expect(ApiConfigSchema.safeParse({ ...productionShaped, fleet: invalid }).success).toBe(
        false,
      );
    }
  });

  it("needs no old monitor settings", () => {
    const config = ApiConfigSchema.parse({ ...productionShaped, fleet: undefined });
    expect(config.fleet).toEqual({ taskQueues: [] });
  });

  it("wires only PM2, the existing Temporal client and OCR, leaving old file paths unused", async () => {
    const jobs = vi.spyOn(Pm2FleetJobs.prototype, "list").mockResolvedValue([]);
    const ocr = vi.spyOn(FleetOcrHealth.prototype, "health").mockResolvedValue({
      configured: false,
      healthy: false,
      statusCode: null,
      body: null,
      error: null,
    });
    const describeTaskQueue = vi
      .fn()
      .mockResolvedValue({ pollers: [{ identity: "77@server-two" }] });
    const client = {
      options: { namespace: "tests" },
      workflowService: { describeTaskQueue },
      connection: {
        withDeadline: async (_deadline: number, call: () => Promise<unknown>) => call(),
      },
    };
    const container = assembleContainer({
      config: ApiConfigSchema.parse(productionShaped),
      temporal: { client } as unknown as TemporalClient,
      log: createLogger({ name: "fleet-test", level: "error" }),
    });
    expect(jobs).not.toHaveBeenCalled();
    const result = await container.cradle.fleet.status();
    expect(jobs).toHaveBeenCalledOnce();
    expect(ocr).toHaveBeenCalledOnce();
    expect(result.local.error).toBeNull();
    expect(result.taskQueues.find((queue) => queue.name === "browser")?.pollers[0]?.identity).toBe(
      "77@server-two",
    );
    expect(describeTaskQueue).toHaveBeenCalledTimes(8);
  });
});
