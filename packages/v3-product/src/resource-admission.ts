import { isDeepStrictEqual } from "node:util";
import { ResourceRequestSchema, type ResourceRequest } from "@crawl-automation/v3-contracts";
import type { CatalogDatabase } from "./catalog-ledger.js";

/** Short transactions only. Waits live in Temporal, not OCR/browser/model execution slots. */
export class PostgresResourceAdmission {
  constructor(private readonly db: CatalogDatabase) {}
  async read(permitId: string) {
    const row = (await this.db.query("SELECT request,released_at FROM resource_permit WHERE permit_id=$1", [permitId])).rows[0];
    if (!row) return null;
    const request = ResourceRequestSchema.parse(row.request);
    if (request.permitId !== permitId) throw Error("RESOURCE.IDENTITY_CONFLICT");
    return { request, released: row.released_at !== null };
  }
  async requireHeld(resourceId:string,workflowId:string,runId:string) {
    const held=await this.db.query("SELECT 1 FROM resource_permit p JOIN resource_permit_need n USING(permit_id) WHERE n.resource_id=$1 AND p.request->>'workflowId'=$2 AND p.request->>'runId'=$3 AND p.released_at IS NULL",[resourceId,workflowId,runId]);
    if(held.rowCount!==1)throw Error("RESOURCE.LEASE_REQUIRED");
  }
  private async transaction<T>(fn: (c: Awaited<ReturnType<CatalogDatabase["connect"]>>) => Promise<T>) {
    const c = await this.db.connect();
    try { await c.query("BEGIN"); const result = await fn(c); await c.query("COMMIT"); return result; }
    catch(e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  async reserve(raw: unknown) {
    const request = ResourceRequestSchema.parse(raw);
    return this.transaction(async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`permit:${request.permitId}`]);
      const prior = (await c.query("SELECT request,released_at FROM resource_permit WHERE permit_id=$1", [request.permitId])).rows[0];
      if (prior) {
        if (!isDeepStrictEqual(ResourceRequestSchema.parse(prior.request), request)) throw Error("RESOURCE.IDENTITY_CONFLICT");
        return { permitId: request.permitId, status: prior.released_at ? "released" : "granted", reason: prior.released_at ? "released" : "available" };
      }
      // All resources lock in canonical order: all-or-nothing, no partial capacity hold/deadlock.
      const needs = [...request.needs].sort((a,b) => a.resourceId.localeCompare(b.resourceId));
      for (const need of needs) {
        const r = (await c.query("SELECT capacity,healthy AND health_until>now() AS ready FROM resource_capacity WHERE resource_id=$1 FOR UPDATE", [need.resourceId])).rows[0];
        if (!r || need.units > r.capacity) throw Error("RESOURCE.NOT_CONFIGURED");
        if (!r.ready) return { permitId: request.permitId, status: "waiting", reason: "unhealthy" };
        const used = (await c.query("SELECT coalesce(sum(n.units),0)::int AS used FROM resource_permit_need n JOIN resource_permit p USING(permit_id) WHERE n.resource_id=$1 AND p.released_at IS NULL", [need.resourceId])).rows[0]!.used;
        if (used + need.units > r.capacity) return { permitId: request.permitId, status: "waiting", reason: "capacity" };
      }
      await c.query("INSERT INTO resource_permit(permit_id,request) VALUES($1,$2)", [request.permitId, request]);
      for (const need of needs) await c.query("INSERT INTO resource_permit_need(permit_id,resource_id,units) VALUES($1,$2,$3)", [request.permitId,need.resourceId,need.units]);
      return { permitId: request.permitId, status: "granted", reason: "available" };
    });
  }
  async release(raw: unknown) {
    const request = ResourceRequestSchema.parse(raw);
    return this.transaction(async c => {
      const prior = (await c.query("SELECT request FROM resource_permit WHERE permit_id=$1 FOR UPDATE", [request.permitId])).rows[0];
      if (!prior || !isDeepStrictEqual(ResourceRequestSchema.parse(prior.request), request)) throw Error("RESOURCE.IDENTITY_CONFLICT");
      await c.query("UPDATE resource_permit SET released_at=coalesce(released_at,now()) WHERE permit_id=$1", [request.permitId]);
      return { permitId: request.permitId, status: "released", reason: "released" };
    });
  }
}
