import { createHash } from "node:crypto";
import { PostgresBrandScans } from "@crawl-automation/adapters";
import type { ScanRecord } from "@crawl-automation/app";
import { createLogger, type TemporalClient } from "@crawl-automation/platform";
import { asValue } from "awilix";
import { afterEach, expect, it, vi } from "vitest";
import { ApiConfigSchema } from "./config.js";
import { assembleContainer } from "./container.js";
import fixture from "./fixtures/api-config.json" with { type: "json" };
import { appWith, query } from "./testing/app-with.js";

afterEach(() => vi.restoreAllMocks());
const scanId = "11111111-1111-4111-8111-111111111111";
const archiveKey = `v3/brand-scans/${scanId}/read-1-page-1-attempt-1.json`;
const url = "https://www.wholefoodsmarket.com/grocery/search?k=Nordic+Naturals&rh=p_123%3A234060";

it("wires scan diagnostics to the existing read-only R2 reader, even when scan submission is disabled", async () => {
  const json = {
    mainResultSet: { availableTotalResultCount: 1, searchResults: [{ asin: "B000000001" }] },
    facets: [{ count: 9000 }],
  };
  const bytes = Buffer.from(JSON.stringify(json));
  const receipt = Buffer.from(
    JSON.stringify({
      codec: "brand-scan-page/1",
      url,
      byteSize: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      creditCost: 1,
    }),
  );
  const read = vi.fn(async (key: string) => (key === archiveKey ? bytes : receipt));
  const get = vi.spyOn(PostgresBrandScans.prototype, "get").mockResolvedValue(record());
  const container = assembleContainer({
    config: ApiConfigSchema.parse({ ...fixture, brandScans: undefined }),
    log: createLogger({ name: "test", level: "error" }),
    temporal: {
      client: {},
      connection: {},
      close: async () => undefined,
    } as unknown as TemporalClient,
  });
  container.register({ storageReaders: asValue({ objects: { read } }) });
  const app = appWith({ brandScans: container.cradle.brandScanParts.brandScans });
  const listed = await app.request(`/trpc/brands.scanEvidence${query({ scanId })}`);
  expect(listed.status).toBe(200);
  expect((await listed.json()).result.data.answers).toMatchObject([
    { productCount: 1, creditCost: 1, empty: false },
  ]);
  const selected = await app.request(`/trpc/brands.scanEvidence${query({ scanId, archiveKey })}`);
  expect(selected.status).toBe(200);
  expect((await selected.json()).result.data).toEqual({ scanId, archiveKey, json });
  expect(get).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledTimes(4);
});

function record(): ScanRecord {
  return {
    scanId,
    requestId: scanId,
    revisitBatchId: scanId,
    state: "partial",
    source: {
      sourceId: scanId,
      brandId: scanId,
      brandName: "Nordic Naturals",
      channel: "wholefoods",
      url,
      enabled: true,
    },
    requestedAt: "2026-10-01T00:00:00Z",
    startedAt: null,
    finishedAt: "2026-10-01T00:01:00Z",
    result: {
      state: "partial",
      pages: 1,
      products: 1,
      families: 0,
      unresolvedFamilies: 0,
      statedTotal: 1,
      full: false,
      newListings: 1,
      knownListings: 0,
      missing: 0,
      queued: 1,
      credits: 1,
      code: null,
      metrics: {
        storeId: "10259",
        unionSize: 1,
        reads: [],
        attempts: [
          {
            read: "read-1",
            page: 1,
            attempt: 1,
            url,
            archiveKey,
            creditCost: 1,
            fromArchive: false,
            empty: false,
            code: null,
          },
        ],
      },
    },
  };
}
