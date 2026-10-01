import { readFileSync } from "node:fs";
import {
  ChannelRegistry,
  HttpCapture,
  ProductCapture,
  ProductPlans,
  ProductSourcePlans,
  ScraperApiPages,
  type PlanSettings,
} from "@crawl-automation/channels-core";
import {
  RetainedPublication,
  sha256,
  type ObjectStore,
  type ScraperApiPage,
} from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import { costcoAdapter } from "./adapter.js";

const html = readFileSync(new URL("./fixtures/product.html", import.meta.url), "utf8");
const url = "https://www.costco.com/test-coq10.product.100029983.html";
const request = {
  channel: "costco" as const,
  url,
  runId: "costco-run",
  operationId: "costco-capture",
  brandId: "brand",
  sourceId: "source",
};
const signal = () => AbortSignal.timeout(5_000);
const settings: PlanSettings = {
  text: {
    schemaVersion: 1,
    module: "codex.text",
    implementationVersion: "codex-text/2",
    policyVersion: "label-text/5",
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
  egressId: "scraperapi-us/1",
  factsPolicy: "text-facts-first/1",
};

function setup(options: { html?: string; finalUrl?: string; status?: number } = {}) {
  const data = new Map<string, Uint8Array>();
  const remote: ObjectStore = {
    read: async (key) => data.get(key) ?? null,
    create: async (key, bytes) => {
      if (data.has(key)) {
        return "exists";
      }
      data.set(key, Buffer.from(bytes));
      return "created";
    },
  };
  const publication = new RetainedPublication(remote, remote);
  const read = vi.fn(async (): Promise<ScraperApiPage> => ({
    bytes: Buffer.from(options.html ?? html),
    url: options.finalUrl ?? url,
    status: options.status ?? 200,
    contentType: "text/html",
    contentEncoding: null,
    creditCost: 10,
  }));
  const pages = new ScraperApiPages(
    { provider: "scraperapi-sync/1", get: read },
    {
      routeId: "test",
      egressId: "test",
      channels: {},
      defaults: { countryCode: "us", sessionNumber: null, render: false, premium: false },
    },
  );
  const adapter = costcoAdapter();
  const registry = new ChannelRegistry([adapter]);
  const capture = new ProductCapture({
    registry,
    http: new HttpCapture(pages),
    publication,
    sourcePlans: new ProductSourcePlans(publication, settings),
  });
  const plans = new ProductPlans({
    registry,
    publication,
    resolver: {
      resolve: async (ref) => ({ ref, bytes: data.get(ref.objectKey) ?? new Uint8Array() }),
    },
    reviews: { read: async () => null, append: vi.fn() },
    integrity: {
      verifyBytes: (ref, bytes) => {
        expect(sha256(bytes)).toBe(ref.sha256);
        expect(bytes.length).toBe(ref.byteSize);
      },
    },
  });
  return { data, capture, plans, read, adapter };
}

it("captures Costco through the shared archive, records warehouse commerce and prepares its label text", async () => {
  const { data, capture, plans, read, adapter } = setup();
  const parse = vi.spyOn(adapter, "parseProduct");
  parse.mockImplementation((page) => {
    expect(data.get("v3/costco-html/costco-capture/original.html")).toEqual(Buffer.from(html));
    return costcoAdapter().parseProduct(page);
  });
  const result = await capture.capture(request, signal());
  expect(result).toMatchObject({
    status: "captured",
    factsComplete: true,
    sourcePlan: {
      channel: "costco",
      parserVersion: "costco-rendered/1",
      owner: { listingId: "100029983" },
      source: { producer: { module: "costco.http-projection" } },
    },
  });
  if (result.status !== "captured") {
    throw new Error("Expected captured product");
  }
  expect(result.page.commerce?.context).toContain("costco-store:669");
  const planned = await plans.run(result.sourcePlan, signal());
  expect(planned.status).toBe("prepared");
  if (planned.status === "prepared") {
    expect(planned.manifest.sources.map((source) => [source.kind, source.required])).toEqual([
      ["page", true],
    ]);
  }
  expect(await capture.capture(request, signal())).toEqual(result);
  expect(await plans.run(result.sourcePlan, signal())).toEqual(planned);
  expect(read).toHaveBeenCalledOnce();
});

it("plans page plus gallery images when printed facts are incomplete", async () => {
  const { capture, plans } = setup({ html: html.replace("Other Ingredients: gelatin, water", "") });
  const result = await capture.capture(request, signal());
  if (result.status !== "captured") {
    throw new Error("Expected captured product");
  }
  const planned = await plans.run(result.sourcePlan, signal());
  expect(planned.status).toBe("prepared");
  if (planned.status === "prepared") {
    expect(planned.manifest.sources.map((source) => source.kind)).toEqual([
      "page",
      "file-image",
      "file-image",
    ]);
  }
});
it.each([
  ["https://www.costco.com/p/-/other/4000100002", "redirected_to_other_product"],
  ["https://www.costco.com/other.product.4000100002.html", "redirected_to_other_product"],
  ["https://www.costco.com/protein.html", "redirected_away"],
])("classifies redirect to %s before parsing", async (finalUrl, reason) => {
  const { capture, adapter } = setup({ finalUrl });
  const parse = vi.spyOn(adapter, "parseProduct");
  expect(await capture.capture(request, signal())).toMatchObject({
    status: "sighted",
    sighting: { state: "unlisted", reason, finalUrl },
  });
  expect(parse).not.toHaveBeenCalled();
});
it("accepts a redirect to the canonical URL of the same product", async () => {
  expect(
    await setup({ finalUrl: "https://www.costco.com/p/-/test-coq10/100029983" }).capture.capture(
      request,
      signal(),
    ),
  ).toMatchObject({ status: "captured" });
});
it("classifies a page-owned identity conflict before formula parsing", async () => {
  const { capture, adapter } = setup({ html: html.replaceAll("100029983", "4000100002") });
  const parse = vi.spyOn(adapter, "parseProduct");
  expect(await capture.capture(request, signal())).toMatchObject({
    status: "sighted",
    sighting: { reason: "identity_conflict", observedListingId: "4000100002" },
  });
  expect(parse).not.toHaveBeenCalled();
});
it.each([404, 410])("classifies HTTP %s as unlisted not_found", async (status) => {
  expect(await setup({ status }).capture.capture(request, signal())).toMatchObject({
    status: "sighted",
    sighting: { state: "unlisted", reason: "not_found", httpStatus: status },
  });
});
