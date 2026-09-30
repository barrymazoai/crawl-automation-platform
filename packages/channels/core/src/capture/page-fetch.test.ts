import { RetainedPublication, type ObjectStore } from "@crawl-automation/v3-artifacts";
import type { ScraperApiPage, ScraperApiRequest } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "../adapter.js";
import { channelErrors } from "../errors.js";
import { HttpCapture } from "./http-capture.js";
import { OriginalHtmlArchive } from "./original-html-archive.js";
import { ScraperApiPages, type ScraperApiCaptureSettings } from "./page-fetch.js";

const ORIGIN = "https://www.gnc.com";
const policy = { origins: [ORIGIN], maxBytes: 10_000, timeoutMs: 5_000 };
const url = `${ORIGIN}/product/877080.html`;
const signal = () => AbortSignal.timeout(5_000);
const settings: ScraperApiCaptureSettings = {
  routeId: "scraperapi-us",
  egressId: "scraperapi-us/1",
  defaults: { countryCode: "us", sessionNumber: null, render: false, premium: false },
  channels: { gnc: { premium: true } },
};

/** A fake ScraperAPI client that answers with one page and records what it was asked. */
function client(page: Partial<ScraperApiPage> = {}) {
  const calls: ScraperApiRequest[] = [];
  const fake = {
    provider: "scraperapi-sync/1" as const,
    get: vi.fn(async (request: ScraperApiRequest): Promise<ScraperApiPage> => {
      calls.push(request);
      const bytes = page.bytes ?? Buffer.from("<html><body>GNC product</body></html>");
      if (bytes.length > request.maxBytes) {
        throw request.tooLarge();
      }
      return {
        status: 200,
        url: request.target,
        contentType: "text/html",
        contentEncoding: null,
        creditCost: 10,
        ...page,
        bytes,
      };
    }),
  };
  return { fake, calls };
}

describe("product pages through ScraperAPI", () => {
  it("uses the channel's own options over the defaults and records them with the credit cost", async () => {
    const { fake, calls } = client();
    const page = await new ScraperApiPages(fake, settings).fetchPage(
      { channel: "gnc", url, policy },
      signal(),
    );
    expect(calls[0]?.options).toEqual({
      countryCode: "us",
      sessionNumber: null,
      render: false,
      premium: true,
    });
    expect(page.fetchedVia).toEqual({
      mode: "http",
      routeId: "scraperapi-us",
      egressId: "scraperapi-us/1",
      provider: "scraperapi-sync/1" as const,
      options: { countryCode: "us", sessionNumber: null, render: false, premium: true },
      creditCost: 10,
    });
  });

  it("uses the defaults for a channel without its own options", async () => {
    const { fake, calls } = client();
    const swanson = {
      channel: "swanson" as const,
      url: "https://www.swansonvitamins.com/p/x",
      policy: { ...policy, origins: ["https://www.swansonvitamins.com"] },
    };
    await new ScraperApiPages(fake, settings).fetchPage(swanson, signal());
    expect(calls[0]?.options).toEqual(settings.defaults);
  });

  it.each([
    [{ status: 404 }, "CAPTURE.NOT_FOUND"],
    [{ contentType: "application/json" }, "CAPTURE.NOT_HTML"],
    [{ contentEncoding: "gzip" }, "CAPTURE.ENCODING"],
    [{ bytes: Buffer.alloc(0) }, "CAPTURE.PAGE_NOT_DELIVERED"],
    [{ bytes: Buffer.alloc(20_000, "x") }, "CAPTURE.PAGE_LIMIT"],
  ])("refuses %j as %s", async (page, code) => {
    const { fake } = client(page);
    await expect(
      new ScraperApiPages(fake, settings).fetchPage({ channel: "gnc", url, policy }, signal()),
    ).rejects.toMatchObject({ code });
  });

  it("never asks ScraperAPI for a page off the channel's sites", async () => {
    const { fake } = client();
    const elsewhere = { channel: "gnc" as const, url: "https://evil.example/x", policy };
    await expect(
      new ScraperApiPages(fake, settings).fetchPage(elsewhere, signal()),
    ).rejects.toMatchObject({
      code: "SOURCE.ORIGIN_BLOCKED",
    });
    expect(fake.get).not.toHaveBeenCalled();
  });
});

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

describe("HttpCapture", () => {
  const adapter: ChannelAdapter = {
    id: "gnc",
    captureModes: ["http"],
    httpPolicy: policy,
    productAddress: (address) => {
      const listingId = /^\/product\/(\d+)\.html$/.exec(new URL(address).pathname)?.[1];
      if (!listingId) {
        throw channelErrors.create("CHANNEL.UNKNOWN");
      }
      return { url: address, listingId, variantId: null };
    },
    parseProduct: (page) =>
      ({ html: page.html, identity: { listingId: "877080", variantId: null } }) as never,
  };
  const capture = {
    operationId: "gnc-op",
    sessionId: "gnc-op",
    url,
    sourceId: "source",
    listingId: "877080",
    variantId: null,
  };

  it("downloads once, archives with how it was fetched, then reads only the archive", async () => {
    const remote = new Memory();
    const publication = new RetainedPublication(new Memory(), remote);
    const archive = () =>
      new OriginalHtmlArchive(publication, { channel: "gnc", capture, maxBytes: policy.maxBytes });
    const { fake } = client();
    const http = new HttpCapture(new ScraperApiPages(fake, settings));
    const first = await http.capture(adapter, archive(), signal());
    await http.capture(adapter, archive(), signal());
    expect(fake.get).toHaveBeenCalledOnce();
    expect(first).toMatchObject({
      status: "page",
      archiveKey: "v3/gnc-html/gnc-op/original.html",
    });
    const receipt = JSON.parse(
      Buffer.from(remote.data.get("v3/gnc-html/gnc-op/original.json") ?? []).toString(),
    );
    expect(receipt.fetchedVia).toMatchObject({ creditCost: 10, options: { premium: true } });
  });

  const captureWith = (page: Partial<ScraperApiPage>, hooks: Partial<ChannelAdapter> = {}) => {
    const publication = new RetainedPublication(new Memory(), new Memory());
    const archive = new OriginalHtmlArchive(publication, {
      channel: "gnc",
      capture,
      maxBytes: policy.maxBytes,
    });
    const { fake } = client(page);
    return new HttpCapture(new ScraperApiPages(fake, settings)).capture(
      { ...adapter, ...hooks },
      archive,
      signal(),
    );
  };

  it.each([404, 410])("reports HTTP %s as unlisted (not found), not a failure", async (status) => {
    expect(await captureWith({ status })).toEqual({
      status: "sighting",
      sighting: {
        state: "unlisted",
        reason: "not_found",
        causeCode: "LISTING.NOT_FOUND",
        httpStatus: status,
        observedListingId: null,
        finalUrl: null,
        archiveKey: null,
      },
    });
  });

  it("reports both page and requested IDs before product parsing can fail", async () => {
    const parseProduct = vi.fn(() => {
      throw new Error("Product parsing must not run for another listing");
    });
    const result = await captureWith(
      {},
      {
        pageIdentity: () => ({ listingId: "999111", variantId: "selected" }),
        parseProduct,
      },
    );
    expect(result).toMatchObject({
      status: "sighting",
      sighting: {
        state: "unlisted",
        reason: "identity_conflict",
        causeCode: "LISTING.IDENTITY_CONFLICT",
        requestedListingId: "877080",
        requestedVariantId: null,
        observedListingId: "999111",
        observedVariantId: "selected",
        archiveKey: "v3/gnc-html/gnc-op/original.html",
      },
    });
    expect(parseProduct).not.toHaveBeenCalled();
  });

  it.each([null, { listingId: "877080", variantId: "selected" }])(
    "does not invent a conflict for an unknown or matching page identity: %j",
    async (identity) => {
      const parseProduct = () =>
        ({ identity: { listingId: "parsed-id", variantId: null } }) as never;
      expect(await captureWith({}, { pageIdentity: () => identity, parseProduct })).toMatchObject({
        status: "page",
      });
    },
  );

  it("compares parsed page identity when the adapter has no early identity hook", async () => {
    const parseProduct = () => ({ identity: { listingId: "999111", variantId: null } }) as never;
    expect(await captureWith({}, { parseProduct })).toMatchObject({
      status: "sighting",
      sighting: {
        state: "unlisted",
        reason: "identity_conflict",
        requestedListingId: "877080",
        observedListingId: "999111",
      },
    });
  });

  it("reports a redirect to a different product as unlisted, naming that product and where it landed", async () => {
    const landed = `${ORIGIN}/product/999111.html`;
    const result = await captureWith({ url: landed });
    expect(result).toMatchObject({
      status: "sighting",
      sighting: {
        state: "unlisted",
        reason: "redirected_to_other_product",
        causeCode: "LISTING.REDIRECTED_TO_OTHER_PRODUCT",
        observedListingId: "999111",
        finalUrl: landed,
      },
    });
  });

  it("reports a redirect to a page that is no product as unlisted (redirected away)", async () => {
    const landed = `${ORIGIN}/brands/gnc/`;
    const result = await captureWith({ url: landed });
    expect(result).toMatchObject({
      status: "sighting",
      sighting: {
        state: "unlisted",
        reason: "redirected_away",
        causeCode: "LISTING.REDIRECTED_AWAY",
        observedListingId: null,
        finalUrl: landed,
      },
    });
  });

  it("reads a redirect that stays on the same listing as that product", async () => {
    const result = await captureWith({ url: `${ORIGIN}/product/877080.html?from=old-link` });
    expect(result).toMatchObject({ status: "page" });
  });
});
