import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  ChannelRegistry,
  HttpCapture,
  ProductCapture,
  ProductSourcePlans,
} from "@crawl-automation/channels-core";
import {
  ScraperApiTransport,
  type HttpRoute,
  type Response,
} from "@crawl-automation/v3-acquisition";
import {
  ArtifactResolver,
  RetainedPublication,
  type ObjectStore,
} from "@crawl-automation/v3-artifacts";
import { ChannelProductPlans, SWANSON_HTTP_POLICY } from "@crawl-automation/v3-channels";
import { describe, expect, it, vi } from "vitest";
import { swansonAdapter } from "./adapter.js";

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

const body = gunzipSync(
  readFileSync(new URL("./fixtures/healthy-origins-d-ribose.html.gz", import.meta.url)),
);
const selection = {
  routeId: "route-test",
  version: "scraperapi/1",
  egressId: "scraperapi-us/1",
  mode: "scraperapi" as const,
  managed: true as const,
  countryCode: "us",
  sessionNumber: null,
  responseMode: "html" as const,
  providerPolicy: "scraperapi-sync/1" as const,
};
const settings = {
  text: {
    schemaVersion: 1 as const,
    module: "codex.text",
    implementationVersion: "codex-text/2",
    policyVersion: "anchored/2",
    resultSchemaVersion: 2 as const,
    configFingerprint: "a".repeat(64),
  },
  ocr: {
    schemaVersion: 1 as const,
    module: "ocr.file",
    implementationVersion: "1",
    policyVersion: "1",
    resultSchemaVersion: 2,
    configFingerprint: "b".repeat(64),
  },
  visionConfigFingerprint: "c".repeat(64),
  egressId: "scraperapi-us/1",
  factsPolicy: "text-facts-first/1" as const,
};
const request = {
  runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
  channel: "swanson" as const,
  url: "https://www.swansonvitamins.com/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr",
  brandId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  operationId: "pipeline-capture-1",
};

function setup() {
  const remote = new Memory();
  const publication = new RetainedPublication(new Memory(), remote);
  const fetches = vi.fn(async (): Promise<Response> => ({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "content-length": String(body.length) },
    body: (async function* () {
      yield body;
    })(),
    close: () => undefined,
  }));
  const transport = new ScraperApiTransport(
    selection,
    { apiKey: "fake-key-000000", allowedOrigins: [...SWANSON_HTTP_POLICY.origins] },
    fetches,
  );
  const route: HttpRoute = { selection, transport, capabilities: transport.capabilities };
  const capture = new ProductCapture({
    registry: new ChannelRegistry([swansonAdapter]),
    http: new HttpCapture(route),
    publication,
    sourcePlans: new ProductSourcePlans(publication, settings),
  });
  const reviews = { read: async () => null, append: async () => undefined };
  const resolver = new ArtifactResolver({ read: async () => null, retain: async () => {} }, remote);
  const plans = new ChannelProductPlans(publication, resolver, reviews);
  return { remote, fetches, capture, plans };
}

const signal = () => AbortSignal.timeout(10_000);

describe("ProductCapture with the Swanson adapter", () => {
  it("archives the page, publishes the projection, and the existing planner accepts it", async () => {
    const { remote, fetches, capture, plans } = setup();

    const result = await capture.capture(request, signal());

    expect(fetches).toHaveBeenCalledOnce();
    expect(remote.data.has("v3/swanson-html/pipeline-capture-1/original.html")).toBe(true);
    expect(remote.data.has(result.sourcePlan.source.objectKey)).toBe(true);
    expect(result.sourcePlan.owner).toMatchObject({
      requestId: request.runId,
      brandId: request.brandId,
      sourceId: request.sourceId,
    });
    expect(result.sourcePlan.owner.variantId).not.toBeNull();
    const planned = await plans.run(result.sourcePlan, signal());
    expect(planned.status).toBe("prepared");
  });

  it("a second capture of the same operation reads the archive and pays nothing", async () => {
    const { fetches, capture } = setup();

    const first = await capture.capture(request, signal());
    const second = await capture.capture(request, signal());

    expect(fetches).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
  });
});
