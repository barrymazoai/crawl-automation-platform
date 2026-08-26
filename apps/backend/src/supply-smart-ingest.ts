import { createHash } from "node:crypto";
import pg from "pg";
import { z } from "zod";

export const normalizedProductSchema = z.object({
  domain: z.string().min(1),
  productName: z.string().min(1),
  productUrl: z.url(),
  channel: z.string().min(1),
  externalId: z.string().min(1),
  sourceUrl: z.url(),
  capturedAt: z.iso.datetime(),
  crawlScope: z.enum(["full", "partial"]),
  source: z.string().min(1),
  sku: z.string().min(1).nullable(),
  skuMissing: z.boolean(),
  price: z.string().optional(),
  currency: z.string().optional(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().min(0).optional(),
  salesRank: z.number().int().positive().optional(),
  inStock: z.boolean().optional(),
  unitsSold: z.number().int().min(0).optional(),
  unitsSoldPeriod: z.string().optional(),
  images: z.array(z.url()),
  healthFunctions: z.array(z.string()),
  mainIngredients: z.array(z.string().trim().min(1)).min(1),
  productForm: z.string(),
  nutritionScope: z.object({
    policy: z.literal("nutrition_single_products"),
    decision: z.literal("included"),
    evidence: z.array(z.string().trim().min(1)).min(1),
  }),
  variantAttrs: z.record(z.string(), z.unknown()).optional(),
  family: z.object({
    name: z.string().min(1),
    label: z.string().min(1).nullable(),
    evidence: z.literal("explicit"),
  }).nullable().optional(),
}).superRefine((value, context) => {
  if ((value.sku === null) !== value.skuMissing) {
    context.addIssue({
      code: "custom",
      message: "sku 与 skuMissing 必须一致：缺失时 sku=null 且 skuMissing=true",
    });
  }
});

export const normalizedProductsSchema = z.array(normalizedProductSchema);
type NormalizedProduct = z.infer<typeof normalizedProductSchema>;

function normalizeDomain(raw: string) {
  return raw.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0]!.toLowerCase();
}

function normalizeListingUrl(raw: string) {
  return raw.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[?#]/)[0]!.replace(/\/+$/, "").toLowerCase();
}

async function loadOne(client: pg.PoolClient, payload: NormalizedProduct) {
  const companyId = (await client.query(`select id from company
     where lower(regexp_replace(coalesce(website,''), '^(https?://)?(www\\.)?', '')) like $1 || '%'
     limit 1`, [normalizeDomain(payload.domain)])).rows[0]?.id;
  if (!companyId) throw new Error(`找不到域名为 ${payload.domain} 的公司`);

  let productId = (await client.query(
    "select id,product_id from product_channel where channel=$1 and external_id=$2 limit 1",
    [payload.channel.toLowerCase(), payload.externalId],
  )).rows[0]?.product_id;
  let familyId = null;
  if (payload.family?.evidence === "explicit") {
    familyId = (await client.query(`insert into product_family(company_id,name) values($1,$2)
       on conflict(company_id,name) do update set updated_at=now() returning id`,
    [companyId, payload.family.name])).rows[0]?.id;
  }

  if (!productId) {
    productId = (await client.query(`insert into product(name,company_id,source,website,original_product_url,provenance,
          family_id,family_label,first_seen_at,last_seen_at)
       values($1,$2,$3,$4,$4,$5::jsonb,$6,$7,$8,$8) returning id`, [
      payload.productName,
      companyId,
      payload.source,
      payload.productUrl,
      JSON.stringify({ source: payload.source, channel: payload.channel, externalId: payload.externalId }),
      familyId,
      payload.family?.label ?? null,
      payload.capturedAt,
    ])).rows[0].id;
  } else {
    await client.query(`update product set name=$2,last_seen_at=greatest(coalesce(last_seen_at,$3),$3),
         family_id=coalesce($4,family_id),family_label=coalesce($5,family_label),updated_at=now() where id=$1`, [
      productId,
      payload.productName,
      payload.capturedAt,
      familyId,
      payload.family?.label ?? null,
    ]);
  }

  const attrs = { ...(payload.variantAttrs ?? {}), sku: payload.sku, sku_missing: payload.skuMissing };
  const listingId = (await client.query(`insert into product_channel(product_id,channel,external_id,title_raw,url_normalized,website,
        original_product_url,attrs,first_seen_at,last_seen_at,status,latest_price,latest_currency,
        latest_rating,latest_review_count,latest_snapshot_at)
     values($1,$2,$3,$4,$5,$6,$6,$7::jsonb,$8,$8,'active',$9,$10,$11,$12,$8)
     on conflict(channel,external_id) where external_id is not null do update set
       title_raw=excluded.title_raw,url_normalized=excluded.url_normalized,attrs=excluded.attrs,
       last_seen_at=greatest(product_channel.last_seen_at,excluded.last_seen_at),status='active',
       latest_price=case when excluded.latest_snapshot_at>coalesce(product_channel.latest_snapshot_at,'epoch'::timestamptz) then excluded.latest_price else product_channel.latest_price end,
       latest_currency=case when excluded.latest_snapshot_at>coalesce(product_channel.latest_snapshot_at,'epoch'::timestamptz) then excluded.latest_currency else product_channel.latest_currency end,
       latest_rating=case when excluded.latest_snapshot_at>coalesce(product_channel.latest_snapshot_at,'epoch'::timestamptz) then excluded.latest_rating else product_channel.latest_rating end,
       latest_review_count=case when excluded.latest_snapshot_at>coalesce(product_channel.latest_snapshot_at,'epoch'::timestamptz) then excluded.latest_review_count else product_channel.latest_review_count end,
       latest_snapshot_at=greatest(coalesce(product_channel.latest_snapshot_at,'epoch'::timestamptz),excluded.latest_snapshot_at),updated_at=now()
     returning id`, [
    productId,
    payload.channel.toLowerCase(),
    payload.externalId,
    payload.productName,
    normalizeListingUrl(payload.sourceUrl),
    payload.sourceUrl,
    JSON.stringify(attrs),
    payload.capturedAt,
    payload.price ?? null,
    payload.currency ?? null,
    payload.rating ?? null,
    payload.reviewCount ?? null,
  ])).rows[0].id;

  await client.query(`insert into listing_snapshot(listing_id,captured_at,source,price,currency,rating,review_count,sales_rank,in_stock,units_sold,units_sold_period)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(listing_id,captured_at,source) do nothing`, [
    listingId,
    payload.capturedAt,
    payload.source,
    payload.price ?? null,
    payload.currency ?? null,
    payload.rating ?? null,
    payload.reviewCount ?? null,
    payload.salesRank ?? null,
    payload.inStock ?? null,
    payload.unitsSold ?? null,
    payload.unitsSoldPeriod ?? null,
  ]);

  for (const url of payload.images) {
    await client.query(`insert into product_image(product_id,listing_id,image_url) select $1,$2,$3
       where not exists(select 1 from product_image where product_id=$1 and image_url=$3)`, [productId, listingId, url]);
  }
  for (const name of payload.healthFunctions) {
    await client.query(`insert into product_health_function(product_id,health_function_id)
       select $1,id from health_function where lower(name)=lower($2) on conflict do nothing`, [productId, name]);
  }
  if (payload.productForm && payload.productForm !== "other") {
    await client.query(`insert into product_form(product_id,form_id) select $1,id from form where lower(name)=lower($2) on conflict do nothing`,
      [productId, payload.productForm]);
  }
  for (const rawName of payload.mainIngredients) {
    const name = rawName.trim();
    if (!name || name.length > 200) continue;
    const ingredientId = (await client.query(`with found as(select id from ingredient where lower(name)=lower($1) limit 1),
       created as(insert into ingredient(name) select $1 where not exists(select 1 from found) returning id)
       select id from found union all select id from created limit 1`, [name])).rows[0]?.id;
    if (ingredientId) {
      await client.query("insert into product_ingredient(product_id,ingredient_id) values($1,$2) on conflict do nothing", [productId, ingredientId]);
    }
  }
}

export class SupplySmartIngest {
  constructor(private readonly pool: pg.Pool) {}

  static fromDatabaseUrl(databaseUrl: string) {
    return new SupplySmartIngest(new pg.Pool({ connectionString: databaseUrl, max: 4 }));
  }

  async ingestAndValidate(rawPayloads: unknown) {
    const payloads = normalizedProductsSchema.parse(rawPayloads);
    const problems: string[] = [];
    for (const payload of payloads) {
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        await loadOne(client, payload);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        problems.push(`${payload.channel}:${payload.externalId}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        client.release();
      }
    }

    const verified: unknown[] = [];
    for (const payload of payloads) {
      const row = (await this.pool.query(
        "select id,product_id,channel,external_id,attrs from product_channel where channel=$1 and external_id=$2 limit 1",
        [payload.channel.toLowerCase(), payload.externalId],
      )).rows[0];
      if (row) verified.push(row);
    }
    verified.sort((a, b) => {
      const left = a as { channel: string; external_id: string };
      const right = b as { channel: string; external_id: string };
      return `${left.channel}:${left.external_id}`.localeCompare(`${right.channel}:${right.external_id}`);
    });
    return {
      loaded: payloads.length - problems.length,
      verified: verified.length,
      problems,
      readbackHash: createHash("sha256").update(JSON.stringify(verified)).digest("hex"),
    };
  }

  async close() {
    await this.pool.end();
  }
}
