import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PostgresMarketplaceReader } from "@crawl-automation/adapters/marketplace-reader";
import { canonicalHash, commerceMetrics } from "@crawl-automation/app";
import {
  marketplaceItem,
  marketplaceLabel,
  type MarketplaceHistory,
} from "@crawl-automation/app/marketplace-mapping";
import { swansonAdapter } from "@crawl-automation/channel-swanson";
import { ChannelRegistry } from "@crawl-automation/channels-core";
import type { Queryable } from "@crawl-automation/platform";

// Real bytes and their capture metadata stay outside git. Database rows below are explicit test doubles.
const pagePath = process.env["CRAWLER_SWANSON_ACGRACE_PAGE"];
const signal = () => new AbortController().signal;
const owner = { listingId: "8572156346506", variantId: "46318677426314" };
const options = { domain: "matched-brand.example", runId: "unit-sync" };

function savedPage() {
  if (!pagePath) {
    throw new Error("CRAWLER_SWANSON_ACGRACE_PAGE is required");
  }
  const bytes = readFileSync(pagePath);
  const meta = z
    .object({
      operationId: z.string(),
      listingId: z.string(),
      variantId: z.string().nullable(),
      capturedAt: z.string(),
      url: z.string(),
      sha256: z.string(),
      byteSize: z.number(),
    })
    .parse(JSON.parse(readFileSync(pagePath.replace(/\.html$/u, ".json"), "utf8")));
  expect(bytes.byteLength).toBe(meta.byteSize);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(meta.sha256);
  const page = { html: bytes.toString("utf8"), url: meta.url, capturedAt: meta.capturedAt };
  return { bytes, meta, page, parsed: swansonAdapter.parseProduct(page) };
}

function setup(format: "html" | "projection") {
  const saved = savedPage();
  const planning = swansonAdapter.planning;
  if (!planning) {
    throw new Error("Missing Swanson planning adapter");
  }
  const projection = planning.projection(saved.parsed.rendered);
  const bytes = format === "html" ? saved.bytes : Buffer.from(JSON.stringify(projection));
  const objectKey = `unit-retained/${format}`;
  const history: MarketplaceHistory = {
    codec: "v3-capture-history/1",
    observationId: saved.meta.operationId,
    capturedAt: saved.meta.capturedAt,
    owner: {
      runId: "unit-run",
      sourceId: "unit-source",
      brandId: "unit-brand",
      operationId: saved.meta.operationId,
    },
    listing: {
      channel: "swanson",
      externalId: saved.parsed.commerce?.sku ?? "",
      url: saved.meta.url,
    },
    capture: { variantId: saved.meta.variantId },
    metrics: { ...commerceMetrics(saved.parsed.commerce) },
    evidence: [{ objectKey, sha256: createHash("sha256").update(bytes).digest("hex") }],
  };
  const queue = {
    item_id: "unit-queue",
    listing_id: saved.meta.listingId,
    variant_id: saved.meta.variantId,
    url: saved.meta.url,
    run_id: history.owner.runId,
    source_id: history.owner.sourceId,
    brand_id: history.owner.brandId,
    brand: "A.C. Grace Company",
    material_at: saved.meta.capturedAt,
  };
  const lookup = vi.fn(() => []);
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql.includes("material_source_id")) {
      return [queue];
    }
    if (sql.includes("product_history_source")) {
      return [{ record: history, body_hash: canonicalHash(history) }];
    }
    if (sql.includes(") known")) {
      expect(values).toEqual([["swanson"], owner.listingId, owner.variantId]);
      return lookup();
    }
    if (sql.includes("SELECT DISTINCT ON")) {
      return []; // No collection for the current run; no enrichment can be requested.
    }
    throw new Error(`Unexpected material query: ${sql}`);
  });
  const objects = { read: vi.fn(async () => bytes as Uint8Array | null) };
  const reader = new PostgresMarketplaceReader({
    database: { query } as Queryable,
    objects,
    channels: new ChannelRegistry([swansonAdapter]),
  });
  return {
    saved,
    planning,
    projection,
    history,
    queue,
    lookup,
    query,
    objects,
    read: async () => (await reader.read({ channel: "swanson", limit: 1 }, signal())).products[0],
  };
}

describe.skipIf(!pagePath)("retained A.C. Grace page with the production Swanson parser", () => {
  it("recovers the capture/planner's numeric owner from HTML and its saved projection", () => {
    const { saved, planning, projection } = setup("html");
    expect(saved.parsed.identity).toEqual(owner);
    expect(planning.identity?.(projection)).toEqual(owner);
    expect(planning.read(projection, saved.page.url, owner).evidence).toMatchObject(owner);
    expect(saved.parsed.evidence.title).toBe("Unique E High Gamma Mixed Tocopherol Concentrate");
    expect(saved.parsed.commerce?.sku).toBe("ACG002");
  });

  it.each(["html", "projection"] as const)(
    "%s reaches the exact formula lookup without a collection and maps a lookup miss without a label",
    async (format) => {
      const fixture = setup(format);
      const input = await fixture.read();
      expect(input?.problem).toBeUndefined();
      expect(fixture.lookup).toHaveBeenCalledOnce();
      if (!input) {
        throw new Error("Missing reader result");
      }
      expect(input.collection).toBeNull();
      expect(input.enrichment).toBeNull();
      expect(input.product).toMatchObject(owner);
      expect(marketplaceLabel(input, options)).toBeNull();
      expect(marketplaceItem(input, options)).toMatchObject({
        externalId: owner.variantId,
        sourceUrl: fixture.saved.meta.url,
        productUrl: fixture.saved.meta.url,
        productName: fixture.saved.parsed.evidence.title,
        titleRaw: fixture.saved.parsed.evidence.title,
        price: "47.29",
        capturedAt: fixture.saved.meta.capturedAt,
      });
      expect(marketplaceItem(input, options)).not.toHaveProperty("currency");
    },
  );

  it("keeps missing and corrupt own bytes explicit and never reaches formula lookup", async () => {
    const missing = setup("html");
    missing.objects.read.mockResolvedValue(null);
    expect(await missing.read()).toMatchObject({ problem: "PRODUCT_DELIVERY.MATERIAL_MISSING" });
    expect(missing.lookup).not.toHaveBeenCalled();
    const corrupt = setup("html");
    corrupt.objects.read.mockResolvedValue(Buffer.from("changed"));
    expect(await corrupt.read()).toMatchObject({ problem: "PRODUCT_DELIVERY.INTEGRITY" });
    expect(corrupt.lookup).not.toHaveBeenCalled();
  });

  it.each(["html", "projection"] as const)(
    "%s refuses a different requested variant even with valid hashes",
    async (format) => {
      const fixture = setup(format);
      fixture.queue.variant_id = "999";
      fixture.queue.url += "?variant=999";
      fixture.history.capture.variantId = "999";
      fixture.history.listing.url = fixture.queue.url;
      expect((await fixture.read())?.problem).toMatch(/^SWANSON\./u);
      expect(fixture.lookup).not.toHaveBeenCalled();
    },
  );
});
