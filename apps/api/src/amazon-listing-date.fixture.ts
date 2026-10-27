import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { vi } from "vitest";
import { amazonAdapter } from "@crawl-automation/channel-amazon";
import { ChannelRegistry, capturedPage } from "@crawl-automation/channels-core";
import {
  canonicalHash,
  captureHistoryEntry,
  listingIdentityResolver,
  type MarketplaceHistory,
} from "@crawl-automation/app";
import { PostgresMarketplaceReader } from "@crawl-automation/adapters";
import type { Queryable } from "@crawl-automation/platform";
import { enrichmentHash, labelCollectedHash } from "@crawl-automation/processing";
import type { LabelCollectedProduct, SharedEnrichmentRecord } from "@crawl-automation/v3-contracts";

interface SavedLabel {
  bytes: Buffer;
  collection: LabelCollectedProduct;
  enrichment: SharedEnrichmentRecord;
}

export const channels = new ChannelRegistry([amazonAdapter]);
export const run = {
  runId: "saved-run",
  operationId: "saved-operation",
  sourceId: "saved-source",
  brandId: "saved-brand",
};
export const capturedAt = "2026-09-23T02:54:24.345Z";

export function fixture(asin: string) {
  const path = new URL(
    `../../../archive/packages/v3-channels/src/fixtures/amazon-static-${asin}.html.gz`,
    import.meta.url,
  );
  return fixtureHtml(asin, gunzipSync(readFileSync(path)));
}

export function fixtureHtml(asin: string, bytes: Buffer) {
  const page = {
    html: bytes.toString("utf8"),
    url: `https://www.amazon.com/dp/${asin}`,
    capturedAt,
  };
  const parsed = amazonAdapter.parseProduct(page);
  const archive = {
    objectKey: `saved/${asin}/original.html`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const history = captureHistoryEntry(
    capturedPage(amazonAdapter, amazonAdapter.productAddress(page.url), {
      parsed,
      archiveKey: archive.objectKey,
      archiveSha256: archive.sha256,
      capturedAt,
    }),
    run,
    listingIdentityResolver(channels),
  );
  return { bytes, parsed, archive, history, page };
}

export function reader(sample: ReturnType<typeof fixture>, label?: SavedLabel) {
  const raw = structuredClone(sample.history.raw) as unknown as MarketplaceHistory;
  // A controlled pre-fix record: the original HTML is unchanged; only the new parser fields are absent.
  const extras = raw.metrics["extras"] as { commerce: Record<string, unknown> };
  delete extras.commerce["dateFirstAvailable"];
  delete extras.commerce["salesRank"];
  raw.metrics["salesRank"] = null;
  const before = canonicalHash(raw);
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM done d")) {
      return [queueRow(sample)];
    }
    if (sql.includes("FROM product_history_source")) {
      return [{ record: raw, body_hash: before }];
    }
    if (label) {
      return labelRows(sql, label);
    }
    if (sql.includes("FROM collected_product") || sql.includes(") known")) {
      return [];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const read = vi.fn(async (key: string): Promise<Uint8Array | null> =>
    key === label?.enrichment.subject.titleEvidence?.sourceId ? label.bytes : sample.bytes,
  );
  const log = { warn: vi.fn() };
  const database = { query } as Queryable;
  const service = new PostgresMarketplaceReader({
    database,
    log,
    objects: { read },
    channels,
  });
  return { raw, before, read, service, database, log };
}

function queueRow(sample: ReturnType<typeof fixture>) {
  return {
    item_id: "saved-item",
    listing_id: sample.parsed.identity.listingId,
    variant_id: null,
    url: sample.page.url,
    run_id: run.runId,
    source_id: run.sourceId,
    brand_id: run.brandId,
    brand: sample.parsed.evidence.brandRaw,
    material_at: capturedAt,
  };
}

function labelRows(sql: string, label: SavedLabel) {
  const { collection, enrichment } = label;
  if (sql.includes("FROM collected_product")) {
    return [
      {
        operation_id: collection.operationId,
        observation_id: collection.observation.observationId,
        record_hash: labelCollectedHash(collection),
        record: collection,
      },
    ];
  }
  if (sql.includes("FROM product_enrichment_subject")) {
    return [
      {
        subject_id: enrichmentHash([enrichment.subject, enrichment.enrichmentId]),
        enrichment_id: enrichment.enrichmentId,
        subject: enrichment.subject,
      },
    ];
  }
  if (sql.includes("FROM product_enrichment WHERE")) {
    return [{ record_hash: enrichmentHash(enrichment), record: enrichment }];
  }
  throw new Error(`Unexpected label query: ${sql}`);
}
