import { Writable } from "node:stream";
import { ChannelRegistry } from "@crawl-automation/channels-core";
import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { fakeAdapter } from "../history/listing-test-helpers.js";
import { BrandSourceImport } from "./source-import.js";

const entry = { name: "Alpha & Co", url: "https://catalog.example/brands/alpha" };
function setup(channel: "gnc" | "wholefoods" = "gnc") {
  const store = {
    brandNames: vi.fn(async () => [
      { brandId: "brand-one", name: "Alpha & Co" },
      { brandId: "brand-two", name: "Alpha and Co™" },
    ]),
    addDisabledSources: vi.fn(async () => ({ created: 1, existing: 2 })),
  };
  const sourceUrl = vi.fn((url: string) => `${url}/`);
  const scanner = { sourceUrl, scan: vi.fn() };
  const reader = {
    sourceUrl,
    pageUrl: vi.fn(),
    parsePage: vi.fn(),
    complete: vi.fn(),
    answer: "html" as const,
    maxPages: 1,
    maxBytes: 100,
  };
  const registry = new ChannelRegistry([fakeAdapter({ brandScan: reader })]);
  const browsers = channel === "wholefoods" ? { wholefoods: scanner } : {};
  const log = createLogger({
    name: "source-test",
    destination: new Writable({ write: (_chunk, _encoding, done) => done() }),
  });
  const deps = { store, registry, browsers, log };
  return { ...deps, sourceUrl, scanner, importer: new BrandSourceImport(deps) };
}

describe("BrandSourceImport.import with fake stores and URL readers", () => {
  it.each(["gnc", "wholefoods"] as const)(
    "imports normalized exact names on %s without starting a scan",
    async (channel) => {
      const fake = setup(channel);
      const result = await fake.importer.import({
        channel,
        entries: [{ ...entry, name: "ALPHA & CO" }],
      });
      expect(result).toEqual({
        created: 1,
        existing: 2,
        looseMatches: [],
        unmatched: [],
        refused: [],
      });
      expect(fake.store.addDisabledSources).toHaveBeenCalledExactlyOnceWith([
        { brandId: "brand-one", channel, url: `${entry.url}/` },
      ]);
      expect(fake.scanner.scan).not.toHaveBeenCalled();
    },
  );

  it("returns all loose candidates and never guesses from punctuation or an empty loose key", async () => {
    const fake = setup();
    const loose = { ...entry, name: "Alpha and Co®" };
    const empty = { ...entry, name: "™®" };
    const unknown = { ...entry, name: "Unknown" };
    expect(
      await fake.importer.import({ channel: "gnc", entries: [loose, empty, unknown] }),
    ).toEqual({
      created: 0,
      existing: 0,
      refused: [],
      looseMatches: [{ ...loose, candidates: ["Alpha & Co", "Alpha and Co™"] }],
      unmatched: [empty, unknown],
    });
    expect(fake.store.addDisabledSources).not.toHaveBeenCalled();
  });

  it.each([
    [Object.assign(new Error("refused"), { code: "BRAND_SCAN.NOT_FOUND" }), "BRAND_SCAN.NOT_FOUND"],
    [new Error("unclassified address"), "BRAND_SCAN.URL"],
  ])("retains the URL refusal code and continues with later entries", async (failure, code) => {
    const fake = setup();
    fake.sourceUrl.mockImplementationOnce(() => {
      throw failure;
    });
    const later = { ...entry, url: `${entry.url}-later` };
    const result = await fake.importer.import({ channel: "gnc", entries: [entry, later] });
    expect(result.refused).toEqual([{ ...entry, code }]);
    expect(fake.store.addDisabledSources).toHaveBeenCalledWith([
      { brandId: "brand-one", channel: "gnc", url: `${later.url}/` },
    ]);
  });

  it.each([
    ["wholefoods", "BRAND_SCAN.BROWSER_NOT_CONFIGURED"],
    ["swanson", "BRAND_SCAN.CHANNEL_UNSUPPORTED"],
  ])("refuses an unavailable %s reader before reading brands", async (channel, code) => {
    const fake = setup();
    await expect(fake.importer.import({ channel, entries: [entry] })).rejects.toMatchObject({
      code,
    });
    expect(fake.store.brandNames).not.toHaveBeenCalled();
  });

  it("refuses a registered channel without a brand reader", async () => {
    const fake = setup();
    const importer = new BrandSourceImport({
      ...fake,
      registry: new ChannelRegistry([fakeAdapter()]),
    });
    await expect(importer.import({ channel: "gnc", entries: [entry] })).rejects.toMatchObject({
      code: "BRAND_SCAN.CHANNEL_UNSUPPORTED",
    });
  });

  it.each([
    {},
    { channel: "gnc", entries: [] },
    { channel: "gnc", entries: [{ ...entry, name: "" }] },
    { channel: "gnc", entries: [{ ...entry, url: "not a URL" }] },
    { channel: "gnc", entries: [entry], extra: true },
  ])("rejects malformed input before any repository access: %j", async (raw) => {
    const fake = setup();
    await expect(fake.importer.import(raw)).rejects.toMatchObject({ name: "ZodError" });
    expect(fake.store.brandNames).not.toHaveBeenCalled();
    expect(fake.store.addDisabledSources).not.toHaveBeenCalled();
  });

  it.each(["brandNames", "addDisabledSources"] as const)(
    "propagates %s failures without retrying",
    async (method) => {
      const fake = setup();
      const failure = new Error("store offline");
      fake.store[method].mockRejectedValue(failure);
      await expect(fake.importer.import({ channel: "gnc", entries: [entry] })).rejects.toBe(
        failure,
      );
      expect(fake.store[method]).toHaveBeenCalledOnce();
      if (method === "brandNames") {
        expect(fake.store.addDisabledSources).not.toHaveBeenCalled();
      }
    },
  );
});
