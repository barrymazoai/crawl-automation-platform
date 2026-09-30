import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  ChannelRegistry,
  HttpCapture,
  ProductCapture,
  ProductPlans,
  ProductSourcePlans,
  ScraperApiPages,
  type PlanSettings,
} from "@crawl-automation/channels-core";
import type { ScraperApiPage, ScraperApiRequest } from "@crawl-automation/platform";
import {
  ArtifactResolver,
  RetainedPublication,
  verifyBytes,
  type ObjectStore,
} from "@crawl-automation/v3-artifacts";
import { describe, expect, it, vi } from "vitest";
import { gncAdapter } from "./gnc-adapter.js";

class Memory implements ObjectStore {
  data = new Map<string, Uint8Array>();
  read = vi.fn(async (key: string) => this.data.get(key) ?? null);
  create = vi.fn(async (key: string, bytes: Uint8Array) => {
    if (this.data.has(key)) {
      return "exists" as const;
    }
    this.data.set(key, Buffer.from(bytes));
    return "created" as const;
  });
}

const url = "https://www.gnc.com/vitamin-d/877080.html";
const body = gunzipSync(
  readFileSync(new URL("./fixtures/product-877080.html.gz", import.meta.url)),
);
const settings: PlanSettings = {
  text: {
    schemaVersion: 1,
    module: "codex.text",
    implementationVersion: "codex-text/2",
    policyVersion: "anchored/2",
    resultSchemaVersion: 2,
    configFingerprint: "a".repeat(64),
  },
  ocr: {
    schemaVersion: 1,
    module: "ocr.file",
    implementationVersion: "1",
    policyVersion: "1",
    resultSchemaVersion: 2,
    configFingerprint: "b".repeat(64),
  },
  visionConfigFingerprint: "c".repeat(64),
  egressId: "scraperapi-us/1",
  factsPolicy: "text-facts-first/1",
};
const request = {
  runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
  channel: "gnc" as const,
  url,
  brandId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  operationId: "pipeline-capture-1",
};

/** The real 877080 page as ScraperAPI answered it (a fake client; no request leaves the test). */
function scraperPages() {
  const client = {
    provider: "scraperapi-sync/1" as const,
    get: vi.fn(async (fetch: ScraperApiRequest): Promise<ScraperApiPage> => ({
      status: 200,
      url: fetch.target,
      contentType: "text/html; charset=utf-8",
      contentEncoding: null,
      bytes: body,
      creditCost: 10,
    })),
  };
  const defaults = { countryCode: "us", sessionNumber: null, render: false, premium: false };
  return new ScraperApiPages(client, {
    routeId: "route-test",
    egressId: "scraperapi-us/1",
    defaults,
    channels: {},
  });
}

describe("GNC product planning on the real 877080 page", () => {
  it("plans the complete Supplement Facts table as the only formula source, with no image", async () => {
    const remote = new Memory();
    const publication = new RetainedPublication(new Memory(), remote);
    const registry = new ChannelRegistry([gncAdapter]);
    const capture = new ProductCapture({
      registry,
      http: new HttpCapture(scraperPages()),
      publication,
      sourcePlans: new ProductSourcePlans(publication, settings),
    });
    const result = await capture.capture(request, AbortSignal.timeout(10_000));
    if (result.status !== "captured") {
      throw new Error(`expected a product page, got ${result.status}`);
    }
    expect(result.sourcePlan).toMatchObject({ channel: "gnc", parserVersion: "gnc-rendered/1" });
    expect(result.sourcePlan.owner).toMatchObject({ listingId: "877080", variantId: null });

    const reviews = { read: async () => null, append: async () => undefined };
    const resolver = new ArtifactResolver(
      { read: async () => null, retain: async () => {} },
      remote,
    );
    const deps = { registry, publication, resolver, reviews, integrity: { verifyBytes } };
    const planned = await new ProductPlans(deps).run(
      result.sourcePlan,
      AbortSignal.timeout(10_000),
    );

    expect(planned.status).toBe("prepared");
    const sources = planned.status === "prepared" ? planned.manifest.sources : [];
    expect(sources.map((source) => [source.kind, source.required])).toEqual([["page", true]]);
  });
});
