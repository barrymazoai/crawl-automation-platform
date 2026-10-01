import { describe, expect, it } from "vitest";
import { LABEL_TEXT_POLICY, WorkerConfigSchema } from "./config.js";
import { workerChannelRegistry } from "./channel-registry.js";

const capture = WorkerConfigSchema.shape.capture.unwrap();
const route = {
  routeId: "scraperapi-us",
  version: "scraperapi/1",
  egressId: "scraperapi-us/1",
  mode: "scraperapi",
  managed: true,
  countryCode: "us",
  sessionNumber: null,
  responseMode: "html",
  providerPolicy: "scraperapi-sync/1",
};
const scraperApi = {
  apiKey: "test_only_canary_NOT_A_KEY",
  allowedOrigins: ["https://www.swansonvitamins.com", "https://www.gnc.com"],
};

it("validates and wires the Swanson public key on the listing worker only", () => {
  const schema = WorkerConfigSchema.shape.brandScans.unwrap();
  const brandScans = schema.parse({
    route,
    scraperApi: {
      ...scraperApi,
      allowedOrigins: [...scraperApi.allowedOrigins, "https://ac.cnstrc.com"],
    },
    swanson: { constructorKey: "test-constructor-key" },
  });
  const source = "https://www.swansonvitamins.com/collections/brand-herb-pharm";
  const adapter = workerChannelRegistry({ brandScans }).forBrandSource("swanson", source);
  const step = adapter.brandScan?.resolve?.({ url: source, brandName: "Herb Pharm" });
  if (!step || !("request" in step)) {
    throw new Error("expected a name lookup request");
  }
  expect(new URL(step.request.url).searchParams.get("key")).toBe("test-constructor-key");
  expect(adapter.httpPolicy.origins).not.toContain("https://ac.cnstrc.com");
  expect(schema.safeParse({ ...brandScans, swanson: { constructorKey: "" } }).success).toBe(false);
});

describe("saved page reuse window", () => {
  it("defaults to seven days and takes a configured number of hours", () => {
    expect(capture.parse({ route, scraperApi }).htmlReuseHours).toBe(168);
    expect(capture.parse({ route, scraperApi, htmlReuseHours: 24 }).htmlReuseHours).toBe(24);
    expect(capture.safeParse({ route, scraperApi, htmlReuseHours: 0 }).success).toBe(false);
  });
});

describe("worker capture settings", () => {
  it("still reads the 2026-09-29 settings, with no channel options", () => {
    expect(capture.parse({ route, scraperApi })).toMatchObject({ channels: {} });
  });

  it("reads a channel's own ScraperAPI options", () => {
    const parsed = capture.parse({ route, scraperApi, channels: { gnc: { premium: true } } });
    expect(parsed.channels).toMatchObject({
      gnc: { premium: true },
      costco: { render: false },
      wholefoods: { headers: { cookie: expect.stringMatching(/^wfm_store_d8=/) } },
    });
  });

  it.each([
    { route: { ...route, responseMode: "binary" }, scraperApi },
    { route, scraperApi, channels: { gnc: { ultraPremium: true } } },
    { route, scraperApi, channels: { walmart: { premium: true } } },
    { route, scraperApi: { ...scraperApi, allowedOrigins: ["http://www.gnc.com"] } },
  ])("refuses settings a page fetch cannot use: %j", (settings) => {
    expect(capture.safeParse(settings).success).toBe(false);
  });
});

describe("worker label settings", () => {
  const labelText = WorkerConfigSchema.shape.label.unwrap().shape.text;
  const text = {
    schemaVersion: 1,
    module: "codex.text",
    implementationVersion: "codex-text/3",
    policyVersion: LABEL_TEXT_POLICY,
    resultSchemaVersion: 3,
    configFingerprint: "a".repeat(64),
  };

  it("accepts the current label protocol", () => {
    expect(labelText.safeParse(text).success).toBe(true);
  });

  it.each(["label-text/1", "label-text/2", "label-text/3"])(
    "refuses %s for new label work",
    (policyVersion) => {
      expect(labelText.safeParse({ ...text, policyVersion }).success).toBe(false);
    },
  );
});
