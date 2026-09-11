import { isDeepStrictEqual as equal } from "node:util";
import { CatalogPageInputSchema, CatalogPageSchema, ArtifactRefSchema, type CatalogPage, type CatalogPageInput } from "@crawl-automation/v3-contracts";
import { RetainedPublication, sha256, verifyBytes } from "@crawl-automation/v3-artifacts";
import { SwansonCatalogProjectionSchema, parseSwansonRenderedCatalog, swansonCatalogAddress } from "./swanson-catalog-rendered.js";

const encode = (v: unknown) => Buffer.from(JSON.stringify(v));
const limit = 2 * 1024 * 1024;
export const swansonCatalogKey = (input: CatalogPageInput) => `v3/swanson-catalog/${sha256(encode(input))}`;
export interface SwansonCatalogPort {
  /** Owns its exact task page, captures public DOM, closes it before returning. */
  capture(input: CatalogPageInput, signal: AbortSignal, retain: (projection: unknown) => Promise<void>): Promise<unknown>;
}

/** One page per call; durable evidence and verification do not depend on a local browser path. */
export class SwansonCatalogSource {
  constructor(readonly publication: RetainedPublication, readonly brandName: string, readonly browser?: SwansonCatalogPort) {}
  private input(raw: unknown) {
    const input = CatalogPageInputSchema.parse(raw);
    if (input.scope.channel !== "swanson" || (input.page===0)!==(input.cursor===null)) throw Error("SWANSON.PAGINATION_UNVERIFIED");
    if(input.cursor){try{if(swansonCatalogAddress(input.cursor)!==input.scope.rootUrl||Number(new URL(input.cursor).searchParams.get("page"))!==input.page+1)throw Error();}
      catch{throw Error("SWANSON.PAGINATION_UNVERIFIED");}}
    return input;
  }
  private derive(input: CatalogPageInput, raw: unknown): CatalogPage {
    const projection = SwansonCatalogProjectionSchema.parse(raw);
    const parsed = parseSwansonRenderedCatalog(projection, input.scope.rootUrl, this.brandName);
    if(Number(new URL(projection.url).searchParams.get("page")??1)!==input.page+1)throw Error("SWANSON.PAGINATION_CONFLICT");
    const bytes = encode(projection), key = swansonCatalogKey(input), id = key.split("/").at(-1)!;
    const source = ArtifactRefSchema.parse({ schemaVersion: 1, artifactId: `catalog-${id}`, observationId: `catalog-${id}`,
      sourceId: input.scope.sourceId, listingId: "catalog", variantId: null, kind: "result-json", mediaType: "application/json",
      objectKey: `${key}/projection.json`, byteSize: bytes.length, sha256: sha256(bytes),
      producer: { operationId: `capture-${id}`, module: "swanson.catalog", implementationVersion: "swanson-catalog/1" } });
    const familyEnd=projection.evidenceVersion===2&&parsed.listingEndVerified;
    return CatalogPageSchema.parse({ codec: "catalog-page/1", input, source,
      ...(projection.evidenceVersion===2&&parsed.reportedTotal!==null?{familyCount:parsed.reportedTotal}:{}),
      entries: parsed.entries.map(e => ({ listingId: e.handle, variantId: null, url: e.url, kind: "family" })),
      // The ledger checks the unique family count across every committed page.
      // Family completeness must never imply absence of a selected SKU.
      completion: parsed.nextUrl?"more":familyEnd?"complete":"unknown", nextCursor: parsed.nextUrl, endEvidence: familyEnd?source:null });
  }
  async inspect(raw: unknown, signal: AbortSignal): Promise<CatalogPage | null> {
    const input = this.input(raw), key = swansonCatalogKey(input);
    const ready = await this.publication.remote.read(`${key}/ready.json`, limit, signal);
    if (!ready) return null;
    const bytes = await this.publication.remote.read(`${key}/projection.json`, limit, signal);
    if (!bytes) throw Error("SWANSON.CATALOG_EVIDENCE_MISSING");
    const page = this.derive(input, JSON.parse(Buffer.from(bytes).toString()));
    if (!equal(JSON.parse(Buffer.from(ready).toString()), page)) throw Error("SWANSON.CATALOG_EVIDENCE_CONFLICT");
    return page;
  }
  async read(raw: unknown, signal: AbortSignal): Promise<CatalogPage> {
    const input = this.input(raw), old = await this.inspect(input, signal);
    if (old) return old;
    if (!this.browser) throw Error("SWANSON.CAPTURE_UNAVAILABLE");
    const key = swansonCatalogKey(input);
    // Claim before navigation. A missing receipt never authorizes recapturing a mutable page.
    if (await this.publication.remote.create(`${key}/intent.json`, encode({ input, brandName: this.brandName }), "application/json", signal) !== "created")
      throw Error("SWANSON.CAPTURE_UNRESOLVED");
    const retain = async (raw: unknown) => {
      const projection = SwansonCatalogProjectionSchema.parse(raw), page = this.derive(input, projection);
      await this.publication.publish(page.source.objectKey, encode(projection), "application/json", signal);
    };
    const projection = SwansonCatalogProjectionSchema.parse(await this.browser.capture(input, signal, retain));
    const page = this.derive(input, projection);
    await this.publication.publish(page.source.objectKey, encode(projection), "application/json", signal);
    await this.publication.publish(`${key}/ready.json`, encode(page), "application/json", signal);
    await this.verify(page, signal);
    return page;
  }
  async verify(raw: CatalogPage, signal: AbortSignal): Promise<void> {
    const page = CatalogPageSchema.parse(raw), input = this.input(page.input);
    const bytes = await this.publication.remote.read(page.source.objectKey, limit, signal);
    if (!bytes) throw Error("SWANSON.CATALOG_EVIDENCE_MISSING");
    verifyBytes(page.source, bytes, limit);
    if (!equal(page, this.derive(input, JSON.parse(Buffer.from(bytes).toString())))) throw Error("SWANSON.CATALOG_EVIDENCE_CONFLICT");
    if (!equal(await this.inspect(input, signal), page)) throw Error("SWANSON.CATALOG_CLOSE_UNVERIFIED");
  }
}
