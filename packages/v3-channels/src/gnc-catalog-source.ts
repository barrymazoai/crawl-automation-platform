import { isDeepStrictEqual } from "node:util";
import { CatalogPageInputSchema, CatalogPageSchema, GncAcquireInputSchema, GncParsedEvidenceSchema,
  type CatalogPage, type CatalogPageInput, type GncAcquireInput } from "@crawl-automation/v3-contracts";
import { verifyBytes } from "@crawl-automation/v3-artifacts";
import type { GncCaptureEvidence } from "./gnc-handoff.js";
/** Durable captured page -> generic catalog protocol. No browser/fetch fallback. */
export class SavedGncCatalogSource {
  private readonly grants: { input: CatalogPageInput; capture: GncAcquireInput }[];
  constructor(private readonly evidence: GncCaptureEvidence, grants: { input: CatalogPageInput; capture: GncAcquireInput }[]) {
    this.grants = grants.map(g => ({ input: CatalogPageInputSchema.parse(g.input), capture: GncAcquireInputSchema.parse(g.capture) }));
  }
  async read(raw: unknown, signal: AbortSignal): Promise<CatalogPage> {
    const input = CatalogPageInputSchema.parse(raw), matches = this.grants.filter(g => isDeepStrictEqual(g.input, input));
    if (matches.length !== 1) throw Error("CATALOG.GRANT_MISMATCH");
    const task = matches[0]!.capture;
    if (input.scope.channel !== "gnc" || task.capture.kind !== "catalog-page" || task.owner.brandId !== input.scope.brandId ||
        task.owner.sourceId !== input.scope.sourceId || task.capture.url !== (input.cursor ?? input.scope.rootUrl)) throw Error("CATALOG.SCOPE_CONFLICT");
    const record = await this.evidence.inspect(task, signal); if (!record) throw Error("CATALOG.PAGE_UNVERIFIED");
    const bytes = await this.evidence.deps.remote.read(record.evidence.objectKey, 8*1024*1024, signal);
    if (!bytes) throw Error("CATALOG.PAGE_UNVERIFIED"); verifyBytes(record.evidence, bytes, 8*1024*1024);
    const parsed = GncParsedEvidenceSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    if (parsed.kind !== "catalog-page" || parsed.data.url !== task.capture.url) throw Error("CATALOG.PAGE_IDENTITY");
    return CatalogPageSchema.parse({ codec: "catalog-page/1", input, source: record.evidence,
      entries: parsed.data.entries.map(e => ({ listingId: e.sku ?? `family-${new URL(e.url).pathname.split("/").at(-1)!.replace(/\.html$/, "")}`,
        variantId: null, kind: e.kind === "sku" ? "product" : "family", url: e.url })),
      nextCursor: parsed.data.nextUrl, completion: parsed.data.completion === "more" ? "more" : parsed.data.countProof && input.page===0 && input.cursor===null ? "complete" : "unknown",
      endEvidence: parsed.data.countProof && input.page===0 && input.cursor===null && !parsed.data.nextUrl ? record.evidence : null });
  }
  async verify(page: CatalogPage, signal: AbortSignal) {
    if (!isDeepStrictEqual(await this.read(page.input, signal), CatalogPageSchema.parse(page))) throw Error("CATALOG.PAGE_CONFLICT");
  }
}
