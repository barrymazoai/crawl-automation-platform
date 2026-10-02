import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amazonAdapter } from "@crawl-automation/channel-amazon";
import { describe, expect, it } from "vitest";
import { WorkerConfigSchema } from "./config.js";
import { buildContainer } from "./container.js";

const fingerprint = "a".repeat(64);
const labelQueue = (name: string) => `v3.label.${name}.v1`;
const gate = {
  queue: "v3.resources.v1",
  releaseOnReview: true,
  activities: {
    interpretText: [{ resourceId: "mini-model-account", units: 1 }],
    interpretImage: [{ resourceId: "mini-model-account", units: 1 }],
    ocrFile: [{ resourceId: "windows-ocr", units: 1 }],
  },
  maxWaitSeconds: 900,
};

/** Shaped like Server 一's worker settings (fake values), with every optional section present. */
async function productionShapedConfig() {
  const root = await mkdtemp(join(tmpdir(), "v3-worker-container-"));
  return WorkerConfigSchema.parse({
    database: { connectionString: "postgresql://user:password@db.test:1/none" },
    temporal: {
      address: "temporal.test:7233",
      namespace: "tests",
      transport: { mode: "insecure" },
    },
    clusterId: "tests",
    processes: {
      pipeline: { roles: [{ role: "pipeline", taskQueue: "v3.pipeline.product.v1" }] },
      label: { roles: [{ role: "label", taskQueue: "v3.label.v1" }] },
    },
    storage: {
      r2: {
        endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
        bucket: "test-bucket",
        prefix: "tests/v3",
        timeoutMs: 20_000,
      },
      r2Credentials: { accessKeyId: "test-key-id", secretAccessKey: "test-secret" },
      journalRoot: join(root, "journal"),
      cacheRoot: join(root, "cache"),
    },
    capture: {
      route: {
        routeId: "scraperapi-us",
        version: "scraperapi/1",
        egressId: "scraperapi-us/1",
        mode: "scraperapi",
        managed: true,
        countryCode: "us",
        sessionNumber: null,
        responseMode: "html",
        providerPolicy: "scraperapi-sync/1",
      },
      scraperApi: { apiKey: "test-key-0000", allowedOrigins: ["https://www.gnc.com"] },
    },
    plan: {
      text: {
        schemaVersion: 1,
        module: "codex.text",
        implementationVersion: "codex-text/2",
        policyVersion: "anchored/2",
        resultSchemaVersion: 2,
        configFingerprint: fingerprint,
      },
      ocr: {
        module: "ocr.file",
        schemaVersion: 1,
        implementationVersion: "multipart-ocr/2",
        policyVersion: "single-call/1",
        resultSchemaVersion: 2,
        configFingerprint: fingerprint,
      },
      visionConfigFingerprint: fingerprint,
      factsPolicy: "text-facts-first/1",
    },
    label: {
      text: {
        schemaVersion: 1,
        module: "codex.text",
        implementationVersion: "codex-text/3",
        policyVersion: "label-text/5",
        resultSchemaVersion: 3,
        configFingerprint: fingerprint,
      },
      visionConfigFingerprint: fingerprint,
      evidencePolicy: "label-image-first/3",
      queues: Object.fromEntries(
        [
          "plan",
          "page",
          "pageText",
          "imagePrepare",
          "ocr",
          "ocrReceipts",
          "keywords",
          "core",
          "source",
          "manifest",
          "text",
          "textReceipts",
          "vision",
          "assembly",
          "collection",
          "review",
        ].map((name) => [name, labelQueue(name)]),
      ),
      resources: gate,
      shared: {
        queues: { activities: "v3.label.v1", ocr: "v3.label.ocr.v1", model: "v3.label.model.v1" },
        resources: gate,
      },
    },
    processing: {
      storageId: "tests",
      nodeId: "server-one",
      ocrApi: { baseUrl: "https://ocr.example.test", provider: "paddle-ocr/1", minScore: 0.3 },
    },
    resourceKinds: { "mini-ego-space-1": "browser" },
    browser: {
      resourceId: "mini-ego-space-1",
      ego: { cliPath: "/usr/local/bin/ego-browser", taskSpaceId: 2 },
      wholefoods: { storeId: "10259", label: "The Alameda", postalCode: "95126" },
    },
  });
}

describe("worker composition root", () => {
  it("builds every registered part of a production-shaped config", async () => {
    const container = await buildContainer(await productionShapedConfig());
    for (const name of Object.keys(container.registrations)) {
      expect(() => container.resolve(name as never), name).not.toThrow();
    }
  });

  it("resolves Amazon HTTP capture alongside Swanson and GNC", async () => {
    const container = await buildContainer(await productionShapedConfig());
    const { registry } = container.cradle;
    expect(registry.channels()).toEqual([
      "swanson",
      "gnc",
      "amazon",
      "wholefoods",
      "costco",
      "dtc",
    ]);
    expect(registry.forCapture("amazon", "http")).toBe(amazonAdapter);
    expect(registry.forCapture("dtc", "browser").planning?.channel).toBe("dtc");
    expect(() => registry.forCapture("dtc", "http")).toThrow();
  });
});
