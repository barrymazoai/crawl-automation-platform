import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiConfigSchema, loadApiConfig, type ApiConfig } from "./config.js";
import productionShaped from "./fixtures/api-config.json" with { type: "json" };

const target = (workflowType: string) => ({
  clusterId: "tests",
  namespace: "tests",
  taskQueue: "v3.pipeline.product.v1",
  workflowType,
});

/** Exercise the real startup loader with an owner-readable private config. */
async function loadSettings(settings: unknown): Promise<ApiConfig> {
  const folder = await mkdtemp(join(tmpdir(), "api-capture-config-"));
  const path = join(folder, "config.json");
  await writeFile(path, JSON.stringify(settings), { mode: 0o600 });
  return loadApiConfig({ V3_API_CONFIG: path });
}

function captureGate(...resourceIds: string[]) {
  return {
    resources: {
      queue: "v3.resources.v1",
      maxWaitSeconds: 900,
      activities: { captureProduct: resourceIds.map((resourceId) => ({ resourceId, units: 1 })) },
    },
  };
}

function withChannels(channels: ApiConfig["pipeline"]["channels"]) {
  return { ...productionShaped, pipeline: { ...productionShaped.pipeline, channels } };
}

describe("API config", () => {
  it("starts brand runs as CollectionWorkflow", () => {
    const config = ApiConfigSchema.parse(productionShaped);
    expect(config.delivery.channels.gnc?.workflowType).toBe("CollectionWorkflow");
  });

  it("refuses the old per-channel brand workflows", () => {
    for (const old of ["BrandCollectionWorkflow", "SwansonCatalogWorkflow"]) {
      const delivery = { ...productionShaped.delivery, channels: { gnc: target(old) } };
      expect(ApiConfigSchema.safeParse({ ...productionShaped, delivery }).success).toBe(false);
    }
  });
});

describe("API capture gates at startup", () => {
  it("loads the production-shaped fixture without a resourceKinds section", async () => {
    await expect(loadSettings(productionShaped)).resolves.toMatchObject({ resourceKinds: {} });
  });

  it("loads both HTTP channels with today's capture permits without resourceKinds", async () => {
    const settings = withChannels({
      gnc: captureGate("scraperapi-lane"),
      swanson: captureGate("scraperapi-lane", "mini-cpu"),
    });
    await expect(loadSettings(settings)).resolves.toMatchObject({ pipeline: settings.pipeline });
  });

  it.each(["gnc", "swanson"] as const)(
    "refuses a browser capture permit on %s even when the other channel is valid",
    async (channel) => {
      const settings = withChannels({
        gnc: captureGate("scraperapi-lane"),
        swanson: captureGate("scraperapi-lane"),
        [channel]: captureGate("ego-space"),
      });
      const resourceKinds = { "ego-space": "browser" };
      await expect(loadSettings({ ...settings, resourceKinds })).rejects.toMatchObject({
        code: "CHANNEL.CAPTURE_LANE_MISMATCH",
      });
    },
  );

  it("refuses an extra browser permit even when the HTTP lane is present", async () => {
    const settings = withChannels({ swanson: captureGate("scraperapi-lane", "ego-space") });
    const resourceKinds = { "ego-space": "browser" };
    await expect(loadSettings({ ...settings, resourceKinds })).rejects.toMatchObject({
      code: "CHANNEL.CAPTURE_LANE_MISMATCH",
    });
  });

  it("uses configured kinds in preference to the shared known kinds", async () => {
    const settings = withChannels({ swanson: captureGate("scraperapi-lane") });
    const resourceKinds = { "scraperapi-lane": "browser" };
    await expect(loadSettings({ ...settings, resourceKinds })).rejects.toMatchObject({
      code: "CHANNEL.CAPTURE_LANE_MISMATCH",
    });
  });

  it("requires a kind for a new capture resource, then accepts its configured HTTP kind", async () => {
    const settings = withChannels({ gnc: captureGate("custom-lane") });
    await expect(loadSettings(settings)).rejects.toMatchObject({
      code: "CHANNEL.RESOURCE_KIND_UNKNOWN",
    });
    const resourceKinds = { "custom-lane": "http-lane" };
    await expect(loadSettings({ ...settings, resourceKinds })).resolves.toMatchObject({
      resourceKinds,
    });
  });

  it("requires a captureProduct gate even when another activity has an HTTP permit", async () => {
    const resources = {
      ...captureGate("scraperapi-lane").resources,
      activities: { downloadFile: [{ resourceId: "scraperapi-lane", units: 1 }] },
    };
    await expect(loadSettings(withChannels({ gnc: { resources } }))).rejects.toMatchObject({
      code: "CHANNEL.CAPTURE_LANE_MISSING",
    });
  });

  it("refuses a capture gate with only a CPU permit", async () => {
    const settings = withChannels({ swanson: captureGate("mini-cpu") });
    await expect(loadSettings(settings)).rejects.toMatchObject({
      code: "CHANNEL.CAPTURE_LANE_MISSING",
    });
  });

  it("refuses a configured channel without a registered adapter", async () => {
    const settings = withChannels({ dtc: captureGate("scraperapi-lane") });
    await expect(loadSettings(settings)).rejects.toMatchObject({ code: "CHANNEL.UNKNOWN" });
  });

  it("rejects resource kinds outside the shared schema", async () => {
    const settings = { ...productionShaped, resourceKinds: { "custom-lane": "gpu" } };
    await expect(loadSettings(settings)).rejects.toMatchObject({
      code: "CONFIG.INVALID",
      details: { issues: ["resourceKinds.custom-lane"] },
    });
  });
});
