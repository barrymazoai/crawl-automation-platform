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
    parseProduct: (page) => ({ html: page.html }) as never,
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

  const captureWith = (page: Partial<ScraperApiPage>) => {
    const publication = new RetainedPublication(new Memory(), new Memory());
    const archive = new OriginalHtmlArchive(publication, {
      channel: "gnc",
      capture,
      maxBytes: policy.maxBytes,
    });
    const { fake } = client(page);
    return new HttpCapture(new ScraperApiPages(fake, settings)).capture(adapter, archive, signal());
  };

  it("reports a page that answers 404 as unlisted (not found), not a failure", async () => {
    expect(await captureWith({ status: 404 })).toEqual({
      status: "sighting",
      sighting: {
        state: "unlisted",
        reason: "not_found",
        causeCode: "LISTING.NOT_FOUND",
        httpStatus: 404,
        observedListingId: null,
        finalUrl: null,
        archiveKey: null,
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
