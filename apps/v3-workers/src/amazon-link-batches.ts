import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import { CatalogScopeSchema, CatalogEntrySchema, CatalogPageInputSchema, CatalogPageSchema, ArtifactRefSchema, type CatalogPage } from "@crawl-automation/v3-contracts";
import { RetainedPublication, sha256, verifyBytes } from "@crawl-automation/v3-artifacts";
import { amazonProductAddress } from "@crawl-automation/v3-channels";

// An imported list is positive input provenance, never a website coverage claim.
export const AmazonLinkBatchSchema = z.strictObject({
  codec: z.literal("amazon-link-batch/1"), requestId: z.uuid(),
  scope: CatalogScopeSchema.refine(s => s.channel === "amazon"),
  candidateManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  entries: z.array(z.strictObject({ entry: CatalogEntrySchema,
    candidateId: z.string().regex(/^[a-f0-9]{64}$/),
    historyListingId: z.string().regex(/^[a-f0-9]{64}$/),
  })).min(1).max(4),
}).superRefine((b, ctx) => {
  const ids = new Set<string>();
  for (const { entry } of b.entries) {
    try {
      const a = amazonProductAddress(entry.url);
      if (a.asin !== entry.listingId || a.url !== entry.url || entry.variantId !== null || entry.kind !== "product" || ids.has(a.asin)) throw Error();
      ids.add(a.asin);
    } catch { ctx.addIssue({ code: "custom", message: "Unique canonical selected Amazon ASIN required" }); }
  }
});
export const AmazonLinkBatchesSchema = z.array(AmazonLinkBatchSchema).max(2000).refine(b => new Set(b.map(x => x.requestId)).size === b.length);
export type AmazonLinkBatch = z.infer<typeof AmazonLinkBatchSchema>;
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));

export class AmazonLinkCatalog {
  readonly batch: AmazonLinkBatch;
  constructor(readonly publication: RetainedPublication, raw: unknown) { this.batch = AmazonLinkBatchSchema.parse(raw); }
  private derive(raw: unknown) {
    const input = CatalogPageInputSchema.parse(raw), b = this.batch;
    if (input.catalogId !== b.requestId || !equal(input.scope, b.scope) || input.page !== 0 || input.cursor !== null) throw Error("AMAZON.LINK_SCOPE_CONFLICT");
    const body = bytes(b), id = sha256(bytes(input));
    const source = ArtifactRefSchema.parse({ schemaVersion: 1, artifactId: `links-${id}`, observationId: `links-${id}`,
      sourceId: input.scope.sourceId, listingId: "catalog", variantId: null, kind: "result-json", mediaType: "application/json",
      objectKey: `v3/amazon-link-batches/${id}/manifest.json`, byteSize: body.length, sha256: sha256(body),
      producer: { operationId: `links-${id}`, module: "amazon.link-list", implementationVersion: "amazon-link-batch/1" } });
    return CatalogPageSchema.parse({ codec: "catalog-page/1", input, source, entries: b.entries.map(x => x.entry),
      nextCursor: null, completion: "unknown", endEvidence: null });
  }
  async read(raw: unknown, signal: AbortSignal) {
    const page = this.derive(raw);
    await this.publication.publish(page.source.objectKey, bytes(this.batch), "application/json", signal);
    await this.verify(page, signal);
    return page;
  }
  async verify(raw: CatalogPage, signal: AbortSignal) {
    const page = CatalogPageSchema.parse(raw), expected = this.derive(page.input);
    if (!equal(page, expected)) throw Error("AMAZON.LINK_EVIDENCE_CONFLICT");
    const body = await this.publication.remote.read(page.source.objectKey, 65536, signal);
    if (!body) throw Error("AMAZON.LINK_EVIDENCE_MISSING");
    verifyBytes(page.source, body, 65536);
    if (!equal(JSON.parse(Buffer.from(body).toString()), this.batch)) throw Error("AMAZON.LINK_EVIDENCE_CONFLICT");
  }
}
