import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import {
  buildPlan,
  ChannelRegistry,
  HttpCapture,
  ProductCapture,
  ProductSourcePlans,
  ScraperApiPages,
  type FetchedPage,
  type PlanSettings,
} from "@crawl-automation/channels-core";
import type { ScraperApiRequest } from "@crawl-automation/platform";
import { amazonAdapter } from "./index.js";
import { savedPage, savedPaths } from "./testing/saved-pages.js";

class Memory {
  readonly data = new Map<string, Uint8Array>();
  async read(key: string) {
    return this.data.get(key) ?? null;
  }
  async create(key: string, bytes: Uint8Array) {
    if (this.data.has(key)) {
      return "exists" as const;
    }
    this.data.set(key, Buffer.from(bytes));
    return "created" as const;
  }
}

/**
 * Structural fake for core's publication port; the adapter has no dependency on legacy storage
 * packages.
 */
class MemoryPublication {
  readonly local = new Memory();
  readonly remote = new Memory();
  async retain(key: string, bytes: Uint8Array) {
    await this.local.create(key, bytes);
  }
  async publish(key: string, bytes: Uint8Array) {
    await this.retain(key, bytes);
    await this.remote.create(key, bytes);
  }
}

const fixture = savedPage(savedPaths.fish);
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
  egressId: "scraperapi-test/1",
  factsPolicy: "text-facts-first/1",
};
const request = {
  runId: "8b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
  channel: "amazon" as const,
  url: "https://www.amazon.com/dp/B0013LAQS6",
  brandId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  operationId: "amazon-test-capture",
};

/**
 * Fake provider and fake object stores only: these tests never download, invoke a model or use
 * credentials.
 */
function captureSetup(page: FetchedPage, response: { status?: number; finalUrl?: string } = {}) {
  const client = {
    provider: "scraperapi-sync/1" as const,
    get: vi.fn(async (input: ScraperApiRequest) => ({
      status: response.status ?? 200,
      url: response.finalUrl ?? input.target,
      contentType: "text/html; charset=utf-8",
      contentEncoding: null,
      bytes: Buffer.from(page.html),
      creditCost: 0,
    })),
  };
  const defaults = { countryCode: "us", sessionNumber: null, render: false, premium: false };
  const pages = new ScraperApiPages(client, {
    routeId: "test-route",
    egressId: "scraperapi-test/1",
    defaults,
    channels: { amazon: { render: true, premium: true } },
  });
  const publication = new MemoryPublication();
  const { remote } = publication;
  const capture = new ProductCapture({
    registry: new ChannelRegistry([amazonAdapter]),
    http: new HttpCapture(pages),
    publication,
    sourcePlans: new ProductSourcePlans(publication, settings),
  });
  return { capture, remote, client };
}

function withCompleteFacts() {
  const page = fixture.read();
  const document = parseHTML(page.html).document;
  const section = document.getElementById("important-information");
  if (!section) {
    throw new Error("Missing saved information block");
  }
  section.innerHTML =
    "<h4>Supplement Facts</h4><p>Serving Size: 2 Softgels</p>" +
    "<table><tr><td>EPA</td><td>650 mg</td></tr></table>" +
    "<h4>Other Ingredients</h4><p>Gelatin, vegetable glycerin.</p>";
  return { ...page, html: document.toString() };
}

describe.skipIf(!fixture.available)(`${fixture.name}: shared capture and planning pipeline`, () => {
  it("archives bytes, forwards HTTP options and reuses the saved capture", async () => {
    const page = fixture.read();
    const setup = captureSetup(page);
    const result = await setup.capture.capture(request, AbortSignal.timeout(10_000));
    expect(result.status).toBe("captured");
    if (result.status !== "captured") {
      throw new Error("Expected capture");
    }
    expect(setup.remote.data.get(result.page.archive.objectKey)).toEqual(Buffer.from(page.html));
    expect(result.sourcePlan).toMatchObject({
      channel: "amazon",
      parserVersion: "amazon-rendered/1",
      source: { producer: { module: "amazon.http-projection" } },
      owner: { listingId: fixture.asin, variantId: null },
    });
    expect(setup.client.get).toHaveBeenCalledWith(
      expect.objectContaining({
        target: request.url,
        maxBytes: amazonAdapter.httpPolicy.maxBytes,
        options: { countryCode: "us", sessionNumber: null, render: true, premium: true },
      }),
      expect.any(AbortSignal),
    );
    expect(await setup.capture.capture(request, AbortSignal.timeout(10_000))).toEqual(result);
    expect(setup.client.get).toHaveBeenCalledTimes(1);
    // This hashes and parses a retained multi-megabyte page twice under suite-wide CPU load.
  }, 20_000);

  it.each([false, true])(
    "keeps image fallback descriptors when page facts are complete=%s",
    async (complete) => {
      const setup = captureSetup(complete ? withCompleteFacts() : fixture.read());
      const result = await setup.capture.capture(request, AbortSignal.timeout(10_000));
      if (result.status !== "captured") {
        throw new Error("Expected capture");
      }
      const bytes = setup.remote.data.get(result.sourcePlan.source.objectKey);
      const projection: unknown = JSON.parse(Buffer.from(bytes ?? []).toString());
      const product = amazonAdapter.planning?.read(
        projection,
        request.url,
        result.sourcePlan.owner,
      );
      if (!product) {
        throw new Error("Expected planning hook");
      }
      const { plan } = buildPlan(result.sourcePlan, product);
      expect(result.factsComplete).toBe(complete);
      expect(result.sourcePlan.sourcePolicy).toEqual({
        version: "label-sources/1",
        order: "images-first",
      });
      expect(plan.files).toHaveLength(6);
      expect(plan.manifest.sources[0]).toMatchObject({ kind: "page", required: complete });
      expect(plan.manifest.sources).toHaveLength(7);
      expect(plan.manifest.sources.slice(1).every((source) => !source.required)).toBe(true);
    },
  );

  it.each([404, 410])("uses core not_found for HTTP %i", async (status) => {
    const setup = captureSetup(fixture.read(), { status });
    await expect(
      setup.capture.capture(request, AbortSignal.timeout(10_000)),
    ).resolves.toMatchObject({
      status: "sighted",
      sighting: { state: "unlisted", reason: "not_found", httpStatus: status },
    });
    expect(setup.client.get).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["https://www.amazon.com/dp/B0G963NB8Q", "redirected_to_other_product", "B0G963NB8Q"],
    ["https://www.amazon.com/s?k=fish+oil", "redirected_away", null],
  ])("uses core redirect reason for %s", async (finalUrl, reason, observedListingId) => {
    const setup = captureSetup(fixture.read(), { finalUrl: finalUrl as string });
    await expect(
      setup.capture.capture(request, AbortSignal.timeout(10_000)),
    ).resolves.toMatchObject({
      status: "sighted",
      sighting: { state: "unlisted", reason, observedListingId, finalUrl },
    });
  });

  it("accepts a same-ASIN redirect to a slugged product URL", async () => {
    const setup = captureSetup(fixture.read(), {
      finalUrl: "https://www.amazon.com/Fish-Oil/dp/B0013LAQS6",
    });
    await expect(
      setup.capture.capture(request, AbortSignal.timeout(10_000)),
    ).resolves.toMatchObject({ status: "captured" });
  });

  it("records core identity_conflict before formula planning", async () => {
    const setup = captureSetup(fixture.read());
    const different = { ...request, url: "https://www.amazon.com/dp/B0G963NB8Q" };
    await expect(
      setup.capture.capture(different, AbortSignal.timeout(10_000)),
    ).resolves.toMatchObject({
      status: "sighted",
      sighting: {
        state: "unlisted",
        reason: "identity_conflict",
        observedListingId: fixture.asin,
        archiveKey: expect.any(String),
      },
    });
  });

  it("never turns a provider challenge into not_found or retries it", async () => {
    const setup = captureSetup(fixture.read(), { status: 503 });
    await expect(setup.capture.capture(request, AbortSignal.timeout(10_000))).rejects.toMatchObject(
      { code: "CAPTURE.ACCESS_CHALLENGE" },
    );
    expect(setup.client.get).toHaveBeenCalledTimes(1);
  });
});
