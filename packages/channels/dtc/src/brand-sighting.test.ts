import { BrowserPages, HttpCapture, OriginalHtmlArchive } from "@crawl-automation/channels-core";
import { RetainedPublication, type ObjectStore } from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import { createDtcAdapter } from "./adapter.js";
import { dtcSitePolicy } from "./site-policy.js";

const origin = "https://shop.example";
const alpha = `${origin}/collections/alpha`;
const beta = `${origin}/collections/beta`;
const url = `${origin}/products/mineral?variant=11`;
const site = dtcSitePolicy({
  siteKey: "shop.example",
  platform: "shopify",
  kind: "multi-brand",
  brands: [
    { brand: "Alpha", catalogUrl: alpha },
    { brand: "Beta", catalogUrl: beta },
  ],
});

class Memory implements ObjectStore {
  readonly data = new Map<string, Uint8Array>();
  read = vi.fn(async (key: string) => this.data.get(key) ?? null);
  create = vi.fn(async (key: string, bytes: Uint8Array) => {
    if (this.data.has(key)) {
      return "exists" as const;
    }
    this.data.set(key, Buffer.from(bytes));
    return "created" as const;
  });
}

function setup(vendor: string | undefined = "Beta") {
  const adapter = createDtcAdapter([site]);
  const product = {
    id: 123,
    handle: "mineral",
    title: "Mineral",
    vendor,
    variants: [{ id: 11, price: 1000, available: true }],
  };
  const html = `<link rel="canonical" href="${origin}/products/mineral">
    <script type="application/json">${JSON.stringify(product)}</script>
    <main><form action="/cart/add"><input name="id" value="11"></form></main>`;
  const read = vi.fn(async () => ({
    url,
    html,
    ready: true,
    status: 200,
    scroll: { rounds: 0, ended: "none" as const },
  }));
  const remote = new Memory();
  const publication = new RetainedPublication(new Memory(), remote);
  const capture = new HttpCapture(
    new BrowserPages(
      { provider: "ego-lite/2", read },
      {
        routeId: "dtc",
        egressId: "task-owned",
        channels: { dtc: { readySelector: "main" } },
      },
    ),
  );
  const archive = (sourceId: string) =>
    new OriginalHtmlArchive(publication, {
      channel: "dtc",
      maxBytes: 10_000,
      capture: {
        ...adapter.productAddress(url),
        sourceId,
        operationId: sourceId,
        sessionId: sourceId,
      },
    });
  return { adapter, capture, archive, remote, read, html };
}

it("archives a cross-brand page and returns identity_conflict before accepting it", async () => {
  const test = setup();
  const scoped = test.adapter.forBrandSource(alpha);
  const parse = vi.spyOn(scoped, "parseProduct");
  const run = () => test.capture.capture(scoped, test.archive("alpha"), AbortSignal.timeout(5000));
  const result = await run();
  expect(result).toMatchObject({
    status: "sighting",
    sighting: {
      state: "unlisted",
      reason: "identity_conflict",
      causeCode: "DTC.BRAND_MISMATCH",
      observedListingId: scoped.productAddress(url).listingId,
      archiveKey: "v3/dtc-html/alpha/original.html",
    },
  });
  expect(
    Buffer.from(test.remote.data.get("v3/dtc-html/alpha/original.html") ?? []).toString(),
  ).toBe(test.html);
  expect(await run()).toEqual(result);
  expect(test.read).toHaveBeenCalledOnce();
  expect(parse).not.toHaveBeenCalled();
  expect(
    await test.capture.capture(
      test.adapter.forBrandSource(beta),
      test.archive("beta"),
      AbortSignal.timeout(5000),
    ),
  ).toMatchObject({ status: "page", parsed: { evidence: { brandRaw: "Beta" } } });
});

it("does not claim a missing page brand is a match or a confirmed conflict", async () => {
  const test = setup(" ");
  await expect(
    test.capture.capture(
      test.adapter.forBrandSource(alpha),
      test.archive("missing"),
      AbortSignal.timeout(5000),
    ),
  ).rejects.toMatchObject({ code: "DTC.BRAND_UNVERIFIED" });
  expect(test.remote.data.has("v3/dtc-html/missing/original.html")).toBe(true);
});

it("refuses multi-brand capture without a task source", async () => {
  const test = setup();
  await expect(
    test.capture.capture(test.adapter, test.archive("unscoped"), AbortSignal.timeout(5000)),
  ).rejects.toMatchObject({ code: "DTC.BRAND_SOURCE_REQUIRED" });
});

it("keeps single-brand capture and historical projection compatibility", async () => {
  const test = setup();
  const adapter = createDtcAdapter([
    dtcSitePolicy({
      siteKey: "shop.example",
      platform: "shopify",
      catalogUrl: `${origin}/collections/all`,
    }),
  ]);
  const result = await test.capture.capture(
    adapter,
    test.archive("single"),
    AbortSignal.timeout(5000),
  );
  expect(result).toMatchObject({
    status: "page",
    parsed: { evidence: { brandRaw: "shop.example" } },
  });
  if (result.status === "page") {
    expect(
      adapter.planning?.read(result.parsed.evidence, url, result.parsed.identity).evidence,
    ).toEqual(result.parsed.evidence);
  }
});
