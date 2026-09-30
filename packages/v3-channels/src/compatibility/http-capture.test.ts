import { OriginalHtmlArchive } from "@crawl-automation/channels-core";
import { SWANSON_HTTP_POLICY } from "@crawl-automation/channel-swanson";
import { RetainedPublication, type ObjectStore } from "@crawl-automation/platform";
import { describe, expect, it } from "vitest";
import { SwansonHtmlArchive } from "../index.js";

function memory(): ObjectStore {
  const objects = new Map<string, Uint8Array>();
  return {
    read: async (key) => objects.get(key) ?? null,
    create: async (key, bytes) => {
      if (objects.has(key)) return "exists";
      objects.set(key, Buffer.from(bytes));
      return "created";
    },
  };
}

const capture = {
  operationId: "swanson-capture-test",
  sessionId: "scraperapi-1",
  url: "https://www.swansonvitamins.com/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr",
  sourceId: "source",
  listingId: "healthy-origins-natural-d-ribose-10-6-oz-pwdr",
  variantId: null,
};
const fetchedVia = { mode: "http" as const, routeId: "r", egressId: "e", provider: "p" };
const body = Buffer.from("<!doctype html><html><body>Retained original</body></html>");

describe("OriginalHtmlArchive and the earlier Swanson archive", () => {
  it.each(["old", "new"])("both readers verify an original written by %s", async (writer) => {
    const publication = new RetainedPublication(memory(), memory());
    const previous = new SwansonHtmlArchive(publication, capture);
    const current = new OriginalHtmlArchive(publication, {
      channel: "swanson",
      capture,
      maxBytes: SWANSON_HTTP_POLICY.maxBytes,
    });
    const signal = AbortSignal.timeout(10000);
    if (writer === "old") await previous.save(body, signal, fetchedVia);
    else await current.save(body, fetchedVia, signal);
    const oldRead = await previous.inspect(signal);
    const newRead = await current.inspect(signal);
    expect(newRead?.source).toEqual(oldRead?.source);
    expect(newRead?.source.objectKey).toBe("v3/swanson-html/swanson-capture-test/original.html");
    expect(Buffer.from(newRead?.bytes ?? [])).toEqual(body);
    expect(Buffer.from(oldRead?.bytes ?? [])).toEqual(body);
  });
});
