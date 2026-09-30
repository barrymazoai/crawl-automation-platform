import { describe, expect, it, vi } from "vitest";
import {
  BrowserPages,
  BrowserProductCapture,
  ChannelRegistry,
  HttpCapture,
  OriginalHtmlArchive,
  ProductSourcePlans,
  ProductPlans,
  type PlanSettings,
} from "@crawl-automation/channels-core";
import { RetainedPublication, verifyBytes, type ObjectStore } from "@crawl-automation/platform";
import { ChannelPlanInputSchema } from "@crawl-automation/v3-contracts";
import { createDtcAdapter } from "./adapter.js";
import { DTC_BROWSER_POLICY, dtcSitePolicy } from "./site-policy.js";

class Memory implements ObjectStore {
  data = new Map<string, Uint8Array>();
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

const site = dtcSitePolicy({
  siteKey: "shop.example",
  platform: "jsonld",
  catalogUrl: "https://shop.example/collections/all",
});
const adapter = createDtcAdapter([site]);
const url = "https://shop.example/products/sleep";
const address = adapter.productAddress(url);
const original = `<html><head><link rel="canonical" href="${url}"></head><body><main><h1>Sleep</h1>
<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Sleep", sku: "123", url, description: "Serving Size: 2 capsules. Magnesium 100 mg. Other Ingredients: cellulose.", offers: { price: "12.50", priceCurrency: "USD" } })}</script></main></body></html>`;

function setup(html = original, readUrl = url) {
  const remote = new Memory();
  const publication = new RetainedPublication(new Memory(), remote);
  const archive = new OriginalHtmlArchive(publication, {
    channel: "dtc",
    maxBytes: 10000,
    capture: {
      ...address,
      operationId: "capture-dtc",
      sessionId: "capture-dtc",
      sourceId: "dtc-source",
    },
  });
  const read = vi.fn(async () => ({
    url: readUrl,
    html,
    status: 200,
    ready: true,
    scroll: { rounds: 0, ended: "none" as const },
  }));
  const pages = new BrowserPages(
    { provider: "ego-lite/2", read },
    { routeId: "ego-test", egressId: "test", channels: { dtc: DTC_BROWSER_POLICY } },
  );
  return { remote, publication, archive, read, capture: new HttpCapture(pages) };
}

describe("DTC through shared BrowserPages (in-memory browser double)", () => {
  it("archives first, parses the product, and reuses original bytes", async () => {
    const { remote, archive, read, capture } = setup();
    const result = await capture.capture(adapter, archive, AbortSignal.timeout(5000));
    expect(result.status).toBe("page");
    if (result.status === "page") {
      expect(result.parsed.commerce?.price).toBe("12.50");
      expect(Buffer.from(remote.data.get(result.archiveKey) ?? []).toString()).toBe(original);
    }
    await capture.capture(adapter, archive, AbortSignal.timeout(5000));
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("lets core classify a wrong canonical page as identity_conflict", async () => {
    const { capture, archive } = setup(
      '<link rel="canonical" href="https://shop.example/products/other">',
    );
    const result = await capture.capture(adapter, archive, AbortSignal.timeout(5000));
    expect(result).toMatchObject({ status: "sighting", sighting: { reason: "identity_conflict" } });
  });
});

const request = {
  runId: "11111111-1111-4111-8111-111111111111",
  channel: "dtc" as const,
  url,
  brandId: "22222222-2222-4222-8222-222222222222",
  sourceId: "33333333-3333-4333-8333-333333333333",
  operationId: "browser-dtc-product",
};
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
    implementationVersion: "ocr/1",
    policyVersion: "ocr/1",
    resultSchemaVersion: 2,
    configFingerprint: "b".repeat(64),
  },
  visionConfigFingerprint: "c".repeat(64),
  egressId: "files/1",
  factsPolicy: "text-facts-first/1",
};

it.each([null, "11"])(
  "hands DTC browser variant %s to the real formula planner",
  async (variantId) => {
    const pageUrl = variantId ? `${url}?variant=${variantId}` : url;
    const html = original.replace('"price":"12.50"', `"url":"${pageUrl}","price":"12.50"`);
    const test = setup(html, pageUrl);
    const registry = new ChannelRegistry([adapter]);
    const browser = new BrowserProductCapture({
      registry,
      http: test.capture,
      publication: test.publication,
      sourcePlans: new ProductSourcePlans(test.publication, settings),
    });
    const result = await browser.capture({ ...request, url: pageUrl }, AbortSignal.timeout(5000));
    expect(result.status).toBe("captured");
    if (result.status !== "captured" || !result.planned) {
      throw new Error("Expected a browser formula plan");
    }
    expect(result.planned.sourcePlan.owner.variantId).toBe(variantId);
    expect(result.planned.sourcePlan.source.producer.module).toBe("dtc.browser-projection");
    expect(test.read).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ url: pageUrl, ...DTC_BROWSER_POLICY }),
      expect.any(AbortSignal),
    );
    const plans = new ProductPlans({
      registry,
      publication: test.publication,
      resolver: {
        resolve: async (ref) => ({
          ref,
          bytes: test.remote.data.get(ref.objectKey) ?? new Uint8Array(),
        }),
      },
      reviews: { read: async () => null, append: vi.fn(async () => undefined) },
      integrity: { verifyBytes },
    });
    expect(await plans.run(result.planned.sourcePlan, AbortSignal.timeout(5000))).toMatchObject({
      status: "prepared",
    });
  },
);

it.each([null, "11", "variant-with-hyphens"])(
  "accepts DTC plan variant %s and retains provenance checks",
  async (variantId) => {
    const test = setup();
    const planning = adapter.planning;
    if (!planning) {
      throw new Error("DTC planning is required");
    }
    const parsed = adapter.parseProduct({
      url,
      html: original,
      capturedAt: "2026-09-30T00:00:00.000Z",
    });
    const sourcePlan = await new ProductSourcePlans(test.publication, settings).publish(
      request,
      { parsed: { ...parsed, identity: { ...parsed.identity, variantId } }, planning },
      AbortSignal.timeout(5000),
    );
    expect(ChannelPlanInputSchema.parse(sourcePlan).owner.variantId).toBe(variantId);
    expect(
      ChannelPlanInputSchema.safeParse({
        ...sourcePlan,
        source: {
          ...sourcePlan.source,
          variantId: "different",
        },
      }).success,
    ).toBe(false);
    expect(
      ChannelPlanInputSchema.safeParse({
        ...sourcePlan,
        source: {
          ...sourcePlan.source,
          producer: { ...sourcePlan.source.producer, module: "dtc.http-projection" },
        },
      }).success,
    ).toBe(false);
  },
);
