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

describe("test evidence settings", () => {
  it("keeps test capture optional for existing API configs", () => {
    expect(ApiConfigSchema.parse(productionShaped).evidence).toBeUndefined();
    expect(ApiConfigSchema.parse({ ...productionShaped, evidence: {} }).evidence).toEqual({});
  });

  it("accepts a separate test prefix and the normal worker's capture options", () => {
    const { route, scraperApi } = productionShaped.brandScans;
    const evidence = {
      testPrefix: "tests/v3/pages",
      capture: { route, scraperApi, channels: { gnc: { premium: true } } },
    };
    expect(ApiConfigSchema.parse({ ...productionShaped, evidence }).evidence).toEqual(evidence);
  });

  it.each([
    "v3/pages",
    "tests",
    "/tests/v3",
    "tests/../v3",
    "tests/v3/",
    "tests//pages",
    "tests/" + "x".repeat(201),
  ])("refuses an unsafe or non-test prefix %s", (testPrefix) => {
    expect(
      ApiConfigSchema.safeParse({ ...productionShaped, evidence: { testPrefix } }).success,
    ).toBe(false);
  });
});

describe("API bind address", () => {
  const hostSchema = ApiConfigSchema.shape.api.shape.host;

  it.each(
    [
      [127, 0, 0, 1],
      [127, 255, 255, 254],
      [10, 0, 0, 0],
      [10, 255, 255, 255],
      [172, 16, 0, 0],
      [172, 31, 255, 255],
      [192, 168, 0, 0],
      [192, 168, 255, 255],
      [100, 64, 0, 0],
      [100, 127, 255, 255],
    ].map((octets) => octets.join(".")),
  )("accepts loopback, RFC 1918 and CGNAT address %s", (host) => {
    expect(hostSchema.parse(host)).toBe(host);
  });

  it.each(["::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:100.64.0.1"])(
    "accepts IPv6 loopback or a mapped allowed IPv4 address %s",
    (host) => expect(hostSchema.parse(host)).toBe(host),
  );

  it.each(
    [
      [0, 0, 0, 0],
      [9, 255, 255, 255],
      [11, 0, 0, 0],
      [126, 255, 255, 255],
      [128, 0, 0, 0],
      [172, 15, 255, 255],
      [172, 32, 0, 0],
      [192, 167, 255, 255],
      [192, 169, 0, 0],
      [100, 0, 0, 1],
      [100, 63, 255, 255],
      [100, 128, 0, 0],
      [100, 255, 255, 255],
      [192, 0, 2, 1],
      [198, 51, 100, 1],
      [169, 254, 0, 1],
      [224, 0, 0, 1],
      [255, 255, 255, 255],
      [127, 256, 0, 1],
      [100, 64, 0, 999],
      [127, 1],
    ].map((octets) => octets.join(".")),
  )("refuses out-of-range or malformed IPv4 address %s", (host) => {
    expect(hostSchema.safeParse(host).success).toBe(false);
  });

  it.each([
    "",
    "localhost",
    "example.test",
    "::",
    "[::1]",
    "fe80::1",
    "fc00::1",
    "2001:db8::1",
    "::ffff:192.0.2.1",
    "::ffff:100.128.0.1",
    "::ffff:127.999.0.1",
  ])("refuses other host input %s", (host) => {
    expect(hostSchema.safeParse(host).success).toBe(false);
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
    const settings = withChannels({ costco: captureGate("scraperapi-lane") });
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

it("accepts DTC browser settings and checks its browser permit kind", async () => {
  const browser = {
    dtc: {
      sites: [
        {
          siteKey: "shop.example",
          platform: "shopify",
          catalogUrl: "https://shop.example/collections/all",
        },
      ],
    },
  };
  const settings = {
    ...withChannels({ dtc: captureGate("dtc-browser") }),
    browser,
    resourceKinds: { "dtc-browser": "browser" },
  };
  expect((await loadSettings(settings)).browser).toEqual(browser);
  expect(ApiConfigSchema.parse({ ...productionShaped, browser: {} }).browser?.dtc.sites).toEqual(
    [],
  );
  await expect(
    loadSettings({ ...settings, resourceKinds: { "dtc-browser": "http-lane" } }),
  ).rejects.toMatchObject({ code: "CHANNEL.CAPTURE_LANE_MISMATCH" });
});
