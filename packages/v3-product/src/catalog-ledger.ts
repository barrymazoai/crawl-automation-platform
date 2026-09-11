import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CatalogScopeSchema, CatalogPageSchema, CatalogDiscoverySchema, CatalogCommitSchema, PresenceInputSchema, PresenceResultSchema,
  ExecutionIdSchema, VersionTagSchema, type CatalogScope, type CatalogPage, type CatalogDiscovery, type CatalogCommit, type PresenceResult } from "@crawl-automation/v3-contracts";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Query = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, any>[]; rowCount: number | null }> };
type Client = Query & { release(): void };
export type CatalogDatabase = Query & { connect(): Promise<Client> };
export const catalogScopeHash = (scope: CatalogScope) => hash(CatalogScopeSchema.parse(scope));
export class PostgresCatalog {
  constructor(private readonly db: CatalogDatabase, private readonly verifyPage: (page: CatalogPage) => Promise<void>) {}
  private async transaction<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const c = await this.db.connect();
    try { await c.query("BEGIN"); const result = await fn(c); await c.query("COMMIT"); return result; }
    catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  private async lock(c: Client, id: string, scope: CatalogScope) {
    const scopeHash = catalogScopeHash(scope);
    await c.query("INSERT INTO catalog_run(catalog_id,scope,scope_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [id, scope, scopeHash]);
    const r = (await c.query("SELECT scope_hash FROM catalog_run WHERE catalog_id=$1 FOR UPDATE", [id])).rows[0];
    if (r?.scope_hash !== scopeHash) throw Error("CATALOG.SCOPE_CONFLICT");
  }
  async commit(raw: unknown): Promise<CatalogCommit> {
    const page = CatalogPageSchema.parse(raw), input = page.input, pageHash = hash(page);
    // The trusted source adapter validates content, not merely that an ArtifactRef is well-shaped.
    await this.verifyPage(page);
    return this.transaction(async c => {
      await this.lock(c, input.catalogId, input.scope);
      const prior = (await c.query("SELECT page_hash FROM catalog_page WHERE catalog_id=$1 AND page_index=$2", [input.catalogId, input.page])).rows[0];
      if (prior && prior.page_hash !== pageHash) throw Error("CATALOG.PAGE_CONFLICT");
      if (!prior) {
        if ((await c.query("SELECT 1 FROM catalog_closure WHERE catalog_id=$1", [input.catalogId])).rowCount) throw Error("CATALOG.CLOSED");
        const previous = (await c.query("SELECT page_index,record FROM catalog_page WHERE catalog_id=$1 ORDER BY page_index DESC LIMIT 1", [input.catalogId])).rows[0];
        if ((!previous && (input.page !== 0 || input.cursor !== null)) || (previous && (previous.page_index + 1 !== input.page ||
            previous.record.completion !== "more" || previous.record.nextCursor !== input.cursor))) throw Error("CATALOG.PAGE_GAP");
        if (page.nextCursor !== null && (await c.query("SELECT 1 FROM catalog_page WHERE catalog_id=$1 AND record->'input'->>'cursor'=$2", [input.catalogId, page.nextCursor])).rowCount)
          throw Error("CATALOG.CURSOR_LOOP");
        await c.query("INSERT INTO catalog_page(catalog_id,page_index,page_hash,record) VALUES($1,$2,$3,$4)", [input.catalogId, input.page, pageHash, page]);
      }
      const discoveries: CatalogDiscovery[] = [];
      for (const entry of page.entries) {
        const key = hash([input.catalogId, entry.listingId, entry.variantId]), discoveryId = `discovery-${key}`;
        const record = CatalogDiscoverySchema.parse({ discoveryId, catalogId: input.catalogId, scope: input.scope, entry, source: page.source, workflowId: `catalog-product-${key}` });
        await c.query("INSERT INTO catalog_discovery(discovery_id,catalog_id,listing_id,variant_key,record,first_page) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
          [discoveryId, input.catalogId, entry.listingId, entry.variantId === null ? "null" : `id:${entry.variantId}`, record, input.page]);
        const prior = (await c.query("SELECT record,first_page FROM catalog_discovery WHERE discovery_id=$1", [discoveryId])).rows[0];
        if (!prior) throw Error("CATALOG.DISCOVERY_UNVERIFIED");
        const existing = CatalogDiscoverySchema.parse(prior.record);
        if (!isDeepStrictEqual(existing.entry, entry) || !isDeepStrictEqual(existing.scope, input.scope)) throw Error("CATALOG.DISCOVERY_CONFLICT");
        // Duplicate cards/pages never start a second product; same page readback keeps its original receipt.
        if (prior.first_page === input.page && !discoveries.some(d => d.discoveryId === discoveryId)) discoveries.push(existing);
      }
      return CatalogCommitSchema.parse({ input, pageHash, discoveries, nextCursor: page.nextCursor, completion: page.completion });
    });
  }
  async dispatch(raw: { discovery: CatalogDiscovery; workflowId: string; runId: string }) {
    const discovery = CatalogDiscoverySchema.parse(raw.discovery);
    if (raw.workflowId !== discovery.workflowId || !z.uuid().safeParse(raw.runId).success) throw Error("CATALOG.DISPATCH_IDENTITY");
    const execution = { workflowId: raw.workflowId, runId: raw.runId };
    const row = (await this.db.query("SELECT record FROM catalog_discovery WHERE discovery_id=$1", [discovery.discoveryId])).rows[0];
    if (!row || !isDeepStrictEqual(CatalogDiscoverySchema.parse(row.record), discovery)) throw Error("CATALOG.DISCOVERY_UNVERIFIED");
    await this.db.query("INSERT INTO catalog_dispatch(discovery_id,execution) VALUES($1,$2) ON CONFLICT DO NOTHING", [discovery.discoveryId, execution]);
    const stored = (await this.db.query("SELECT execution FROM catalog_dispatch WHERE discovery_id=$1", [discovery.discoveryId])).rows[0];
    if (!isDeepStrictEqual(stored?.execution, execution)) throw Error("CATALOG.DISPATCH_CONFLICT");
  }
  async close(input: { catalogId: string; scope: CatalogScope; failure: string | null }) {
    input = z.strictObject({ catalogId: ExecutionIdSchema, scope: CatalogScopeSchema, failure: VersionTagSchema.nullable() }).parse(input);
    const scope = CatalogScopeSchema.parse(input.scope);
    return this.transaction(async c => {
      await this.lock(c, input.catalogId, scope);
      const saved = (await c.query("SELECT record FROM catalog_closure WHERE catalog_id=$1", [input.catalogId])).rows[0];
      if (saved) return { status: saved.record.status as "complete" | "incomplete" };
      const last = (await c.query("SELECT page_index,page_hash,record FROM catalog_page WHERE catalog_id=$1 ORDER BY page_index DESC LIMIT 1", [input.catalogId])).rows[0];
      const stats = (await c.query("SELECT count(*)::int AS pages,min(page_index) AS first,max(page_index) AS last FROM catalog_page WHERE catalog_id=$1", [input.catalogId])).rows[0]!;
      const pending = (await c.query("SELECT count(*)::int AS count FROM catalog_discovery d LEFT JOIN catalog_dispatch x USING(discovery_id) WHERE d.catalog_id=$1 AND x.discovery_id IS NULL", [input.catalogId])).rows[0]!.count;
      let familyCoverage:{unit:"families";expected:number;discovered:number}|undefined,countVerified=true;
      const pages=(await c.query("SELECT record FROM catalog_page WHERE catalog_id=$1 ORDER BY page_index",[input.catalogId])).rows;
      const declared=pages.find(p=>p.record.familyCount!==undefined)?.record.familyCount;
      if(declared!==undefined){
        const unique=new Set<string>();for(const p of pages){if(p.record.familyCount!==declared)countVerified=false;for(const e of p.record.entries){if(e.kind!=="family"||e.variantId!==null)countVerified=false;unique.add(e.listingId);}}
        familyCoverage={unit:"families",expected:declared,discovered:unique.size};countVerified=countVerified&&unique.size===declared;
      }
      const complete = !input.failure && countVerified && last?.record.completion === "complete" && stats.first === 0 && stats.pages === stats.last + 1 && pending === 0;
      const status = complete ? "complete" as const : "incomplete" as const;
      const record = { codec: "catalog-closure/1", catalogId: input.catalogId, scope, status, pages: stats.pages,
        ...(familyCoverage?{coverage:familyCoverage}:{}),
        lastPageHash: last?.page_hash ?? null, endEvidence: last?.record.endEvidence ?? null,
        failure: input.failure ?? (complete ? null : "CATALOG.COVERAGE_UNVERIFIED"), pendingDispatches: pending };
      await c.query("INSERT INTO catalog_closure(catalog_id,status,record,record_hash) VALUES($1,$2,$3,$4)", [input.catalogId, status, record, hash(record)]);
      return { status };
    });
  }
  async presence(raw: unknown): Promise<PresenceResult> {
    const input = PresenceInputSchema.parse(raw);
    return this.transaction(async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [input.operationId]);
      const prior = (await c.query("SELECT record FROM presence_result WHERE operation_id=$1", [input.operationId])).rows[0];
      if (prior) { const record = PresenceResultSchema.parse(prior.record); if (!isDeepStrictEqual(record.input, input)) throw Error("PRESENCE.INPUT_CONFLICT"); return record; }
      const run = (await c.query("SELECT scope_hash FROM catalog_run WHERE catalog_id=$1", [input.catalogId])).rows[0];
      if (!run) throw Error("PRESENCE.CATALOG_UNAVAILABLE");
      const same = run.scope_hash === catalogScopeHash(input.scope);
      const found = same ? (await c.query("SELECT discovery_id,record FROM catalog_discovery WHERE catalog_id=$1 AND listing_id=$2 AND variant_key=$3",
        [input.catalogId, input.listingId, input.variantId === null ? "null" : `id:${input.variantId}`])).rows[0] : null;
      const closed = same ? (await c.query("SELECT status,record_hash,record FROM catalog_closure WHERE catalog_id=$1", [input.catalogId])).rows[0] : null;
      const familyOnly=closed?.record?.coverage?.unit==="families";
      const status = found ? "exists" : closed?.status === "complete"&&!familyOnly ? "confirmed_absent" : "unknown";
      const result = PresenceResultSchema.parse({ codec: "presence/1", input, status, checkedAt: new Date().toISOString(),
        code: found ? "PRESENCE.DISCOVERED" : !same ? "PRESENCE.SCOPE_MISMATCH" : status === "confirmed_absent" ? "PRESENCE.COMPLETE_CATALOG_ABSENCE" : familyOnly?"PRESENCE.VARIANT_COVERAGE_UNVERIFIED":"PRESENCE.CATALOG_INCOMPLETE",
        evidence: found ? [{ key: found.discovery_id, sha256: hash(CatalogDiscoverySchema.parse(found.record)) }] : closed ? [{ key: input.catalogId, sha256: closed.record_hash }] : [] });
      await c.query("INSERT INTO presence_result(operation_id,catalog_id,record,record_hash) VALUES($1,$2,$3,$4)", [input.operationId, input.catalogId, result, hash(result)]);
      return result;
    });
  }
}
