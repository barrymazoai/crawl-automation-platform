import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  HttpCapture,
  OriginalHtmlArchive,
  type HttpCaptureResult,
} from "@crawl-automation/channels-core";
import { RetainedPublication, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { SWANSON_HTTP_POLICY, SwansonHtmlArchive } from "@crawl-automation/v3-channels";
import { describe, expect, it, vi } from "vitest";
import { swansonAdapter } from "./adapter.js";
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

const url = "https://www.swansonvitamins.com/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr";
const body = gunzipSync(
  readFileSync(new URL("./fixtures/healthy-origins-d-ribose.html.gz", import.meta.url)),
);
const capture = {
  operationId: "swanson-capture-test",
  sessionId: "scraperapi-1",
  url,
  sourceId: "source",
  listingId: "healthy-origins-natural-d-ribose-10-6-oz-pwdr",
  variantId: null,
};

function setup(status = 200, finalUrl?: string) {
  const remote = new Memory();
  const publication = new RetainedPublication(new Memory(), remote);
  const { fetches, pages } = fakeScraperApiPages(body, status, finalUrl);
  const archive = () =>
    new OriginalHtmlArchive(publication, {
      channel: "swanson",
      capture,
      maxBytes: SWANSON_HTTP_POLICY.maxBytes,
    });
  return { remote, publication, fetches, capture: new HttpCapture(pages), archive };
}

const signal = () => AbortSignal.timeout(10_000);

/** The parsed page of a capture that read a product page. */
function pageOf(result: HttpCaptureResult) {
  if (result.status !== "page") {
    throw new Error(`expected a product page, got a ${result.sighting.state} listing`);
  }
  return result;
}

describe("HttpCapture with the Swanson adapter", () => {
  it("downloads once, archives before parsing, then only reads the archive", async () => {
    const { remote, fetches, capture: http, archive } = setup();

    const first = pageOf(await http.capture(swansonAdapter, archive(), signal()));
    const second = pageOf(await http.capture(swansonAdapter, archive(), signal()));

    expect(fetches).toHaveBeenCalledOnce();
    expect(first.parsed.evidence.title).toMatch(/D-Ribose/i);
    expect(second.parsed.evidence).toEqual(first.parsed.evidence);
    expect(first.archiveKey).toBe("v3/swanson-html/swanson-capture-test/original.html");
    expect(Buffer.from(remote.data.get(first.archiveKey) ?? []).equals(body)).toBe(true);
  });

  it("archives nothing for a refused page and never pays for a second download", async () => {
    const { remote, fetches, capture: http, archive } = setup(403);

    // Through ScraperAPI the provider reports the refusal itself, before the capture sees the status.
    await expect(http.capture(swansonAdapter, archive(), signal())).rejects.toMatchObject({
      code: "SCRAPERAPI.PROVIDER_FAILURE",
    });
    await expect(http.capture(swansonAdapter, archive(), signal())).rejects.toMatchObject({
      code: "CAPTURE.DOWNLOAD_UNRESOLVED",
    });
    expect(fetches).toHaveBeenCalledOnce();
    expect(remote.data.has("v3/swanson-html/swanson-capture-test/original.html")).toBe(false);
  });
});

describe("a revisit of a Swanson listing that is no longer that product", () => {
  it("reports a page that answers 404 as gone, archiving nothing", async () => {
    const { remote, capture: http, archive } = setup(404);
    const result = await http.capture(swansonAdapter, archive(), signal());
    expect(result).toMatchObject({
      status: "sighting",
      sighting: { state: "gone", causeCode: "CAPTURE.NOT_FOUND", httpStatus: 404 },
    });
    expect(remote.data.has("v3/swanson-html/swanson-capture-test/original.html")).toBe(false);
  });

  it("reports a redirect to another product as superseded by that product's handle", async () => {
    const moved = "https://www.swansonvitamins.com/p/healthy-origins-d-ribose-new";
    const { capture: http, archive } = setup(200, moved);
    const result = await http.capture(swansonAdapter, archive(), signal());
    expect(result).toMatchObject({
      status: "sighting",
      sighting: { state: "superseded", observedListingId: "healthy-origins-d-ribose-new" },
    });
  });
});

describe("OriginalHtmlArchive and the earlier Swanson archive", () => {
  const fetchedVia = { mode: "http" as const, routeId: "r", egressId: "e", provider: "p" };

  it("reads an original the earlier Swanson archive wrote, and the other way round", async () => {
    const { publication, archive } = setup();
    await new SwansonHtmlArchive(publication, capture).save(body, signal(), fetchedVia);

    const read = await archive().inspect(signal());

    expect(read && Buffer.from(read.bytes).equals(body)).toBe(true);
    const again = await new SwansonHtmlArchive(publication, capture).inspect(signal());
    expect(again?.source).toEqual(read?.source);
  });
});
