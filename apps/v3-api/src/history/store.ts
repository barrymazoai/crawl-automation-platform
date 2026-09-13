import type pg from "pg";
import { canonical, hash, type ConvertedProduct } from "./model.js";

/** A caller-owned client permits both serial imports and isolated integration tests. */
export class ProductHistory {
  constructor(private readonly db: Pick<pg.PoolClient, "query">) {}
  async verify(values:ConvertedProduct[]) {
    const ids=values.map(v=>v.id);
    const saved=new Map((await this.db.query("SELECT source_record_id,body_hash,record FROM product_history_source WHERE source_record_id=ANY($1::text[])",[ids])).rows.map(r=>[r.source_record_id,r]));
    const listings=new Map((await this.db.query("SELECT source_record_id,array_agg(listing_id ORDER BY listing_id) ids FROM product_history_listing_source WHERE source_record_id=ANY($1::text[]) GROUP BY source_record_id",[ids])).rows.map(r=>[r.source_record_id,r.ids]));
    const observations=new Map((await this.db.query("SELECT source_record_id,array_agg(observation_id ORDER BY observation_id) ids FROM product_history_observation_source WHERE source_record_id=ANY($1::text[]) GROUP BY source_record_id",[ids])).rows.map(r=>[r.source_record_id,r.ids]));
    const expectedObservations=values.flatMap(v=>v.observations);
    const contents=new Map((await this.db.query("SELECT observation_id,listing_id,kind,observed_at,record FROM product_history_observation WHERE observation_id=ANY($1::text[])",[expectedObservations.map(o=>o.id)])).rows.map(r=>[r.observation_id,r]));
    for(const v of values){
      const r=saved.get(v.id);
      if(!r||r.body_hash!==v.bodyHash||canonical(r.record)!==canonical(v.raw)||
        canonical(listings.get(v.id)??[])!==canonical(v.listings.map(l=>l.id).sort())||
        canonical(observations.get(v.id)??[])!==canonical(v.observations.map(o=>o.id).sort()))throw Error("HISTORY.READBACK_MISMATCH");
    }
    for(const o of expectedObservations){
      const r=contents.get(o.id);
      if(!r||r.listing_id!==o.listingId||r.kind!==o.kind||(r.observed_at?.toISOString()??null)!==o.observedAt||canonical(r.record)!==canonical(o.record))throw Error("HISTORY.OBSERVATION_READBACK_MISMATCH");
    }
    return values.length;
  }
  async append(value: ConvertedProduct) {
    if (hash(value.raw) !== value.bodyHash) throw Error("HISTORY.INPUT_HASH");
    await this.db.query("BEGIN");
    try {
      const prior = (await this.db.query("SELECT body_hash,record FROM product_history_source WHERE source_record_id=$1", [value.id])).rows[0];
      if (prior) {
        if (prior.body_hash !== value.bodyHash || canonical(prior.record) !== canonical(value.raw)) throw Error("HISTORY.CONTENT_CONFLICT");
        await this.db.query("COMMIT"); return { inserted: false };
      }
      const inserted=await this.db.query(`INSERT INTO product_history_source(source_record_id,dataset,source_key,body_hash,record,issues)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT DO NOTHING RETURNING source_record_id`,
      [value.id,value.dataset,value.sourceKey,value.bodyHash,JSON.stringify(value.raw),JSON.stringify(value.issues)]);
      for (const l of value.listings) {
        await this.db.query(`INSERT INTO product_history_listing(listing_id,channel,site,external_id,identity_basis,identity)
          VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`, [l.id,l.channel,l.site,l.externalId,l.basis,JSON.stringify(l.identity)]);
        await this.db.query("INSERT INTO product_history_listing_source VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [l.id,value.id,l.url]);
      }
      for (const o of value.observations) {
        await this.db.query(`INSERT INTO product_history_observation(observation_id,listing_id,kind,observed_at,record)
          VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`, [o.id,o.listingId,o.kind,o.observedAt,JSON.stringify(o.record)]);
        await this.db.query("INSERT INTO product_history_observation_source VALUES($1,$2) ON CONFLICT DO NOTHING", [o.id,value.id]);
      }
      const saved = (await this.db.query("SELECT body_hash,record FROM product_history_source WHERE source_record_id=$1", [value.id])).rows[0];
      if (!saved || saved.body_hash !== value.bodyHash || canonical(saved.record) !== canonical(value.raw)) throw Error("HISTORY.READBACK_MISMATCH");
      await this.db.query("COMMIT"); return { inserted: !!inserted.rowCount };
    } catch (e) { await this.db.query("ROLLBACK"); throw e; }
  }
  async inventory() {
    return (await this.db.query(`SELECT dataset,count(*)::int source_records,
      (SELECT count(DISTINCT listing_id)::int FROM product_history_listing_source l WHERE l.source_record_id IN
        (SELECT source_record_id FROM product_history_source ss WHERE ss.dataset=s.dataset)) listings
      FROM product_history_source s GROUP BY dataset ORDER BY dataset`)).rows;
  }
}
