import { createHash } from "node:crypto";
import {
  ChannelRegistry,
  type BrandScanReader,
  type ChannelAdapter,
} from "@crawl-automation/channels-core";
import { createLogger } from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import { BrandScanService } from "./brand-scan-service.js";
import type { BrandScanStore } from "./ports.js";
import type { ScanRecord } from "./scan-model.js";

const scanId = "11111111-1111-4111-8111-111111111111";
const archiveKey = `v3/brand-scans/${scanId}/read-1-page-1-attempt-1.json`;
const recordKey = archiveKey.replace(/\.json$/, ".record.json");
const url = "https://example.test/search";
const json = {
  items: ["one", "two", "one"],
  total: 3,
  facets: { arbitrary: "preserved" },
  nextPageToken: "token",
};

function fixture(body = JSON.stringify(json)) {
  const bytes = Buffer.from(body);
  const receipt = {
    codec: "brand-scan-page/1",
    url,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
    creditCost: 2,
  };
  const objects = new Map([
    [archiveKey, bytes],
    [recordKey, Buffer.from(JSON.stringify(receipt))],
  ]);
  const read = vi.fn(async (key: string) => objects.get(key) ?? null);
  const scan = scanRecord();
  const get = vi.fn(async (): Promise<ScanRecord | null> => scan);
  const parsePage = vi.fn(() => ({
    products: json.items.map((listingId) => ({
      url,
      listingId,
      variantId: null,
      title: null,
      kind: "product" as const,
    })),
    cards: 3,
    statedTotal: 3,
    nextPage: null,
  }));
  const registry = new ChannelRegistry([
    {
      id: "wholefoods",
      brandScan: { parsePage } as unknown as BrandScanReader,
    } as ChannelAdapter,
  ]);
  const deps = {
    store: { get } as unknown as BrandScanStore,
    registry,
    browsers: {},
    enabled: false,
    log: createLogger({ name: "test", level: "error" }),
    objects: { read },
  };
  return { scans: new BrandScanService(deps), deps, get, scan, read, parsePage, objects, receipt };
}

function scanRecord(): ScanRecord {
  return {
    scanId,
    requestId: scanId,
    revisitBatchId: scanId,
    state: "partial",
    source: {
      sourceId: scanId,
      brandId: scanId,
      brandName: "Example",
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
      products: 2,
      families: 0,
      unresolvedFamilies: 0,
      statedTotal: 3,
      full: false,
      newListings: 2,
      knownListings: 0,
      missing: 0,
      queued: 2,
      credits: 2,
      code: null,
      metrics: {
        storeId: "10259",
        unionSize: 2,
        reads: [],
        attempts: [
          {
            read: "read-1",
            page: 1,
            attempt: 1,
            archiveKey,
            url,
            creditCost: 2,
            empty: false,
            code: null,
            fromArchive: false,
          },
        ],
      },
    },
  };
}

it("lists recorded saved answers with distinct product counts and original costs without scan configuration", async () => {
  const test = fixture();
  expect(await test.scans.evidence({ scanId })).toMatchObject({
    scanId,
    state: "partial",
    recorded: true,
    answers: [
      {
        read: "read-1",
        page: 1,
        attempt: 1,
        archiveKey,
        productCount: 2,
        creditCost: 2,
        empty: false,
        statedTotal: 3,
        inspectionCode: null,
      },
    ],
  });
  expect(test.get).toHaveBeenCalledExactlyOnceWith(scanId);
  expect(test.read.mock.calls.map(([key]) => key)).toEqual([recordKey, archiveKey]);
  expect(test.parsePage).toHaveBeenCalledExactlyOnceWith({
    body: JSON.stringify(json),
    url,
    page: 1,
  });
});

it("returns the entire JSON including unknown facets and pagination tokens without filtering through the channel parser", async () => {
  const test = fixture();
  expect(await test.scans.evidence({ scanId, archiveKey })).toEqual({ scanId, archiveKey, json });
  expect(test.parsePage).not.toHaveBeenCalled();
});

it.each(["different.json", "v3/secrets.json", `v3/brand-scans/${scanId}/../secret.json`])(
  "refuses unrecorded keys without reading storage: %s",
  async (key) => {
    const test = fixture();
    await expect(test.scans.evidence({ scanId, archiveKey: key })).rejects.toMatchObject({
      code: "EVIDENCE.NOT_FOUND",
    });
    expect(test.read).not.toHaveBeenCalled();
  },
);

it("refuses a key from another scan even if corrupted metrics reference it", async () => {
  const test = fixture();
  const key = archiveKey.replace(scanId, "22222222-2222-4222-8222-222222222222");
  const attempt = test.scan.result?.metrics?.attempts[0];
  if (attempt) {
    attempt.archiveKey = key;
  }
  await expect(test.scans.evidence({ scanId, archiveKey: key })).rejects.toMatchObject({
    code: "EVIDENCE.NOT_FOUND",
  });
  expect(test.read).not.toHaveBeenCalled();
});

it("checks the scan exists and validates inputs before accessing objects", async () => {
  const test = fixture();
  test.get.mockResolvedValue(null);
  await expect(test.scans.evidence({ scanId })).rejects.toMatchObject({ code: "SCAN.NOT_FOUND" });
  await expect(test.scans.evidence({ scanId: "invalid" })).rejects.toThrow();
  expect(test.get).toHaveBeenCalledOnce();
  expect(test.read).not.toHaveBeenCalled();
});

it("returns a truthful empty inventory when a running or historical scan has no metrics", async () => {
  const test = fixture();
  test.scan.result = null;
  test.scan.state = "running";
  expect(await test.scans.evidence({ scanId })).toEqual({
    scanId,
    state: "running",
    recorded: false,
    answers: [],
  });
  expect(test.read).not.toHaveBeenCalled();
});

it("does not confuse missing storage settings with a missing archive", async () => {
  const test = fixture();
  const scans = new BrandScanService({ ...test.deps, objects: undefined });
  await expect(scans.evidence({ scanId, archiveKey })).rejects.toMatchObject({
    code: "EVIDENCE.READ_NOT_CONFIGURED",
  });
});

it.each(["body", "hash", "size", "receipt"])(
  "refuses an unverified archive (%s) and reports its inventory error",
  async (fault) => {
    const test = fixture();
    if (fault === "body") {
      test.objects.set(archiveKey, Buffer.from("tampered"));
    } else if (fault === "receipt") {
      test.objects.delete(recordKey);
    } else {
      const receipt = {
        ...test.receipt,
        [fault === "hash" ? "sha256" : "byteSize"]: fault === "hash" ? "0".repeat(64) : 1,
      };
      test.objects.set(recordKey, Buffer.from(JSON.stringify(receipt)));
    }
    await expect(test.scans.evidence({ scanId, archiveKey })).rejects.toMatchObject({
      code: "BRAND_SCAN.ARCHIVE_UNVERIFIED",
    });
    expect(await test.scans.evidence({ scanId })).toMatchObject({
      answers: [{ productCount: null, inspectionCode: "BRAND_SCAN.ARCHIVE_UNVERIFIED" }],
    });
    expect(test.parsePage).not.toHaveBeenCalled();
  },
);

it("reports missing bodies and malformed JSON without fetching a replacement", async () => {
  const missing = fixture();
  missing.objects.delete(archiveKey);
  await expect(missing.scans.evidence({ scanId, archiveKey })).rejects.toMatchObject({
    code: "EVIDENCE.NOT_FOUND",
  });
  const invalid = fixture("not JSON");
  await expect(invalid.scans.evidence({ scanId, archiveKey })).rejects.toMatchObject({
    code: "BRAND_SCAN.NOT_JSON",
  });
  expect(await invalid.scans.evidence({ scanId })).toMatchObject({
    answers: [{ productCount: null, inspectionCode: "BRAND_SCAN.NOT_JSON" }],
  });
});
