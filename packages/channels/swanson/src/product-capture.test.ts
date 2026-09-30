import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  ChannelRegistry,
  HttpCapture,
  ProductCapture,
  ProductPlans,
  ProductSourcePlans,
  type PlanSettings,
  type ProductCaptureResult,
} from "@crawl-automation/channels-core";
import {
  ArtifactResolver,
  RetainedPublication,
  verifyBytes,
  type ObjectStore,
} from "@crawl-automation/v3-artifacts";
import { describe, expect, it, vi } from "vitest";
import { swansonAdapter } from "./adapter.js";
import { extractSwansonLabelCore } from "./label-core.js";
import { fakeScraperApiPages } from "./testing/fake-scraperapi.js";

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

/** Real archived pages (see fixtures/README.md). */
const pages = {
  dRibose: {
    file: "healthy-origins-d-ribose.html.gz",
    url: "https://www.swansonvitamins.com/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr",
  },
  ubiquinol: {
    file: "healthy-origins-ubiquinol-variant.html.gz",
    url: "https://www.swansonvitamins.com/p/healthy-origins-ubiquinol-kaneka-qh-100-mg-60-sgels?variant=46318812168330",
  },
};
type Page = (typeof pages)[keyof typeof pages];
const pageBytes = (page: Page) =>
  gunzipSync(readFileSync(new URL(`./fixtures/${page.file}`, import.meta.url)));
const settings: PlanSettings = {
  text: {
    schemaVersion: 1 as const,
    module: "codex.text" as const,
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
  url: pages.dRibose.url,
  brandId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  operationId: "pipeline-capture-1",
};

function setup(page: Page = pages.dRibose) {
  const body = pageBytes(page);
  const remote = new Memory();
  const publication = new RetainedPublication(new Memory(), remote);
  const { fetches, pages: scraperPages } = fakeScraperApiPages(body);
  const registry = new ChannelRegistry([swansonAdapter]);
  const capture = new ProductCapture({
    registry,
    http: new HttpCapture(scraperPages),
    publication,
    sourcePlans: new ProductSourcePlans(publication, settings),
  });
  const reviews = { read: async () => null, append: async () => undefined };
  const resolver = new ArtifactResolver({ read: async () => null, retain: async () => {} }, remote);
  const integrity = { verifyBytes };
  const plans = new ProductPlans({ registry, publication, resolver, reviews, integrity });
  return { remote, fetches, capture, plans };
}

const signal = () => AbortSignal.timeout(10_000);

/** A capture that read a product page (not a listing found unlisted). */
function captured(result: ProductCaptureResult) {
  if (result.status !== "captured") {
    throw new Error(`expected a product page, got a listing unlisted as ${result.sighting.reason}`);
  }
  return result;
}

describe("ProductCapture with the Swanson adapter", () => {
  it("records another product's unchanged page as unlisted, with both handles and its original", async () => {
    const { remote, fetches, capture } = setup();
    const wrongRequest = { ...request, url: pages.ubiquinol.url };
    const first = await capture.capture(wrongRequest, signal());
    expect(first).toMatchObject({
      status: "sighted",
      listingId: swansonAdapter.productAddress(pages.ubiquinol.url).listingId,
      sighting: {
        state: "unlisted",
        reason: "identity_conflict",
        causeCode: "LISTING.IDENTITY_CONFLICT",
        requestedListingId: swansonAdapter.productAddress(pages.ubiquinol.url).listingId,
        observedListingId: swansonAdapter.productAddress(pages.dRibose.url).listingId,
        archiveKey: "v3/swanson-html/pipeline-capture-1/original.html",
      },
    });
    expect(remote.data.get("v3/swanson-html/pipeline-capture-1/original.html")).toEqual(
      pageBytes(pages.dRibose),
    );
    expect([...remote.data.keys()].some((key) => key.endsWith("projection.json"))).toBe(false);
    expect(await capture.capture(wrongRequest, signal())).toEqual(first);
    expect(fetches).toHaveBeenCalledOnce();
  });

  it("records a different requested variant as an identity conflict", async () => {
    const { capture } = setup(pages.ubiquinol);
    const url = new URL(pages.ubiquinol.url);
    url.searchParams.set("variant", "999999999");
    expect(await capture.capture({ ...request, url: url.href }, signal())).toMatchObject({
      status: "sighted",
      variantId: "999999999",
      sighting: {
        state: "unlisted",
        reason: "identity_conflict",
        requestedVariantId: "999999999",
        observedVariantId: "46318812168330",
      },
    });
  });

  it("archives the page, publishes the projection, and the existing planner accepts it", async () => {
    const { remote, fetches, capture, plans } = setup();

    const result = captured(await capture.capture(request, signal()));

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

  it("returns what the page showed for the metrics history: its commerce, history ID and archived original", async () => {
    const { remote, capture } = setup();

    const { page } = captured(await capture.capture(request, signal()));

    expect(page).toMatchObject({ channel: "swanson", capturedAt: expect.any(String) });
    expect(page.externalId).toMatch(/^([A-Z][A-Z0-9-]{2,30}|shopify-variant:.+)$/);
    expect(page.commerce?.price).toBeTruthy();
    expect(remote.data.has(page.archive.objectKey)).toBe(true);
    expect(page.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("a second capture of the same operation reads the archive and pays nothing", async () => {
    const { fetches, capture } = setup();

    const first = await capture.capture(request, signal());
    const second = await capture.capture(request, signal());

    expect(fetches).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
  });

  // 2026-09-29: the static reader ran table rows together, and the Swanson label core refused every HTTP capture
  // with LABEL_CORE.TABLE_UNVERIFIED (Serving Size / Amount Per Serving must start their own lines).
  it.each(Object.entries(pages))(
    "the planner's facts fragment of %s passes the Swanson label core",
    async (_name, page) => {
      const { remote, capture, plans } = setup(page);

      const { sourcePlan } = captured(
        await capture.capture({ ...request, url: page.url }, signal()),
      );
      const planned = await plans.run(sourcePlan, signal());

      expect(planned.status).toBe("prepared");
      const fragment = remote.data.get(`v3/channel-plans/${sourcePlan.operationId}/derived.html`);
      const facts = extractSwansonLabelCore(Buffer.from(fragment ?? []).toString());
      expect(facts).toMatch(/^Serving Size\b/m);
      expect(facts).toMatch(/^Amount Per Serving\b/m);
      expect(facts).toMatch(/^Other Ingredients:/m);
    },
  );
});
