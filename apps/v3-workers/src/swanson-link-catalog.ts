import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import { CatalogPageInputSchema, CatalogPageSchema, ArtifactRefSchema, type CatalogPage } from "@crawl-automation/v3-contracts";
import { RetainedPublication, sha256, verifyBytes } from "@crawl-automation/v3-artifacts";
import { swansonProductAddress } from "@crawl-automation/v3-channels";

/** A Swanson product list (family pages /p/<handle>, e.g. from the products.json brand scan). Positive input
 * provenance for one catalog request, never a website coverage claim: completion is always "unknown". */
export const SwansonProductListSchema = z.strictObject({
  codec: z.literal("swanson-product-list/1"), requestId: z.uuid(),
  urls: z.array(z.string().url().max(4096)).min(1).max(100),
}).superRefine((l, ctx) => {
  const handles = new Set<string>();
  for (const u of l.urls) {
    try {
      const a = swansonProductAddress(u);
      if (a.variantId !== null || a.url.pathname !== `/p/${a.handle}` || a.url.href !== u || handles.has(a.handle)) throw Error();
      handles.add(a.handle);
    } catch { ctx.addIssue({ code: "custom", message: "Unique canonical https://www.swansonvitamins.com/p/<handle> URLs required" }); }
  }
});
export type SwansonProductList = z.infer<typeof SwansonProductListSchema>;
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));

export class SwansonLinkCatalog {
  readonly list: SwansonProductList;
  constructor(readonly publication: RetainedPublication, raw: unknown) { this.list = SwansonProductListSchema.parse(raw); }
  private derive(raw: unknown): CatalogPage {
    const input = CatalogPageInputSchema.parse(raw), l = this.list;
    if (input.catalogId !== l.requestId || input.scope.channel !== "swanson" || input.page !== 0 || input.cursor !== null) throw Error("SWANSON.LINK_SCOPE_CONFLICT");
    const body = bytes(l), id = sha256(bytes(input));
    const source = ArtifactRefSchema.parse({ schemaVersion: 1, artifactId: `links-${id}`, observationId: `links-${id}`,
      sourceId: input.scope.sourceId, listingId: "catalog", variantId: null, kind: "result-json", mediaType: "application/json",
      objectKey: `v3/swanson-link-lists/${id}/manifest.json`, byteSize: body.length, sha256: sha256(body),
      producer: { operationId: `links-${id}`, module: "swanson.link-list", implementationVersion: "swanson-product-list/1" } });
    const entries = l.urls.map(u => ({ listingId: swansonProductAddress(u).handle, variantId: null, url: u, kind: "family" as const }));
    return CatalogPageSchema.parse({ codec: "catalog-page/1", input, source, entries, nextCursor: null, completion: "unknown", endEvidence: null });
  }
  async read(raw: unknown, signal: AbortSignal) {
    const page = this.derive(raw);
    await this.publication.publish(page.source.objectKey, bytes(this.list), "application/json", signal);
    await this.verify(page, signal);
    return page;
  }
  async verify(raw: CatalogPage, signal: AbortSignal) {
    const page = CatalogPageSchema.parse(raw), expected = this.derive(page.input);
    if (!equal(page, expected)) throw Error("SWANSON.LINK_EVIDENCE_CONFLICT");
    const body = await this.publication.remote.read(page.source.objectKey, 65536, signal);
    if (!body) throw Error("SWANSON.LINK_EVIDENCE_MISSING");
    verifyBytes(page.source, body, 65536);
    if (!equal(JSON.parse(Buffer.from(body).toString()), this.list)) throw Error("SWANSON.LINK_EVIDENCE_CONFLICT");
  }
}
