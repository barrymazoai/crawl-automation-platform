import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { EnrichmentService, EnrichmentTitleReader } from "@crawl-automation/app";
import { createDtcAdapter, dtcSitePolicy } from "@crawl-automation/channel-dtc";
import { ChannelRegistry } from "@crawl-automation/channels-core";
import { ArtifactResolver, sha256 } from "@crawl-automation/platform";
import { enrichmentHash } from "@crawl-automation/processing";
import {
  EnrichmentRequestSchema,
  EnrichmentSubjectSchema,
  LabelCollectedProductSchema,
  SharedEnrichmentRecordSchema,
  type SharedEnrichmentRecord,
} from "@crawl-automation/v3-contracts";

const directory = process.env["CRAWL_RETAINED_DTC_BASE_ENRICHMENT"];

it.skipIf(!directory)(
  "registers HMW's retained answer without an undefined default variant or a new model call",
  async () => {
    if (!directory) {
      throw new Error("Retained evidence directory required; run on a Mini only");
    }
    const inputBytes = await readFile(join(directory, "input.json"));
    const response = await readFile(join(directory, "response.txt"));
    const savedRecord = SharedEnrichmentRecordSchema.parse(
      JSON.parse(await readFile(join(directory, "record.json"), "utf8")),
    );
    expect(sha256(inputBytes)).toBe(
      "c0588ae41a93615f1f3a75b6ee066f1c81e6d65f9ddf509db840e8c60797c3d8",
    );
    expect(sha256(response)).toBe(savedRecord.responseSha256);
    const retained = JSON.parse(inputBytes.toString());
    const request = EnrichmentRequestSchema.parse(retained.request);
    const original = EnrichmentSubjectSchema.parse(retained.subject);
    const collection = LabelCollectedProductSchema.parse(retained.collection);
    const projection = await readFile(join(directory, "projection.json"));
    const noNetwork = async (): Promise<never> => {
      throw new Error("Network forbidden in retained replay");
    };
    const artifacts = new ArtifactResolver(
      { read: async () => projection, retain: noNetwork },
      { read: noNetwork, create: noNetwork },
    );
    const registry = new ChannelRegistry([
      createDtcAdapter([
        dtcSitePolicy({
          siteKey: "shop.hmwmethod.com",
          platform: "shopify",
          kind: "multi-brand",
          brands: [
            { brand: "HMW Method", catalogUrl: "https://shop.hmwmethod.com/collections/all" },
          ],
        }),
      ]),
    ]);
    const titles = new EnrichmentTitleReader(registry, artifacts);
    const subject = await titles.read(request, original, AbortSignal.timeout(5000));
    expect(subject.variantId).toBeNull();
    expect(Object.hasOwn(subject, "websiteVariant")).toBe(false);
    expect(() => enrichmentHash(subject)).not.toThrow();
    const records = new Map<string, SharedEnrichmentRecord>();
    const objects = new Map<string, Uint8Array>();
    const interpret = vi.fn(async () => response.toString());
    const appendReview = vi.fn(noNetwork);
    const service = new EnrichmentService({
      titles,
      repository: {
        source: async () => ({ collection, subject: original }),
        missing: async () => [],
        claim: async () => true,
        read: async (key) => records.get(key) ?? null,
        register: async (record) => {
          const hash = enrichmentHash(record);
          const stored = SharedEnrichmentRecordSchema.parse(JSON.parse(JSON.stringify(record)));
          expect(enrichmentHash(stored)).toBe(hash);
          records.set(record.inputHash, stored);
        },
        attach: async (owner, key) => {
          expect(owner).toEqual(subject);
          expect(records.has(key)).toBe(true);
        },
      },
      publication: {
        publish: async (key, bytes) => {
          objects.set(key, bytes);
        },
      },
      remote: { read: async (key) => objects.get(key) ?? null },
      reviews: { read: async () => null, append: appendReview },
      model: { provider: savedRecord.provider, interpret },
    });
    const outcome = await service.run(request, AbortSignal.timeout(5000));
    expect(outcome).toMatchObject({
      status: "registered",
      enrichmentId: retained.inputHash,
      candidate: savedRecord.candidate,
    });
    expect(records.get(retained.inputHash)?.formulaHash).toBe(savedRecord.formulaHash);
    expect(interpret).toHaveBeenCalledOnce(); // Returns only the already retained answer above.
    expect(appendReview).not.toHaveBeenCalled();
    expect(retained.subject).toEqual(original);
  },
);
