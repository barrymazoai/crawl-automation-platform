import { createHash } from "node:crypto";
import pg from "pg";
import { z } from "zod";

export const EnrichIngredientSchema = z.union([
  z.string().trim().min(1),
  z.object({
    name: z.string().trim().min(1),
    substance: z.string().trim().min(1).optional(),
    form: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
  }).refine((value) => !value.form || Boolean(value.substance), {
    message: "ingredient.form 必须同时提供 substance",
  }),
]);

export const normalizedProductSchema = z.object({
  domain: z.string().trim().min(1),
  productName: z.string().trim().min(1),
  productUrl: z.url(),
  channel: z.string().trim().toLowerCase().min(1),
  externalId: z.string().trim().min(1),
  sourceUrl: z.url(),
  capturedAt: z.iso.datetime(),
  crawlScope: z.enum(["full", "partial"]),
  source: z.string().trim().min(1),
  sku: z.string().trim().min(1).nullable(),
  skuMissing: z.boolean(),
  price: z.string().optional(),
  currency: z.string().optional(),
  listPrice: z.string().optional(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().nonnegative().optional(),
  salesRank: z.number().int().positive().optional(),
  inStock: z.boolean().optional(),
  unitsSold: z.number().int().nonnegative().optional(),
  unitsSoldPeriod: z.enum(["trailing_30d", "monthly", "lifetime", "unknown"]).optional(),
  images: z.array(z.url()),
  healthFunctions: z.array(z.string().trim().min(1)),
  mainIngredients: z.array(EnrichIngredientSchema).min(1),
  productForm: z.string().trim().min(1),
  nutritionScope: z.object({
    policy: z.literal("nutrition_single_products"),
    decision: z.literal("included"),
    evidence: z.array(z.string().trim().min(1)).min(1),
  }),
  variantAttrs: z.record(z.string(), z.unknown()).optional(),
  family: z.object({
    parentExternalId: z.string().min(1).nullable(),
    label: z.string().min(1).nullable(),
    name: z.string().trim().min(1).optional(),
    evidence: z.literal("explicit"),
  }).nullable().optional(),
}).superRefine((value, context) => {
  if ((value.sku === null) !== value.skuMissing) {
    context.addIssue({ code: "custom", message: "sku 与 skuMissing 必须一致" });
  }
});

export const factsRowSchema = z.object({
  name: z.string().trim().min(1),
  amountValue: z.number().nonnegative().nullable().optional(),
  amountUnit: z.string().trim().nullable().optional(),
  dvPercent: z.number().nonnegative().nullable().optional(),
  position: z.number().int().nonnegative(),
  isActive: z.boolean().default(true),
  parentPosition: z.number().int().nonnegative().nullable().optional(),
});

export const productFactsSchema = z.object({
  channel: z.string().trim().toLowerCase().min(1),
  externalId: z.string().trim().min(1),
  sourceUrl: z.url(),
  capturedAt: z.iso.datetime(),
  source: z.string().trim().min(1),
  confidence: z.number().int().min(0).max(100),
  servingSize: z.number().positive().nullable().optional(),
  servingUnit: z.string().trim().nullable().optional(),
  servingsPerContainer: z.number().int().positive().nullable().optional(),
  netContent: z.string().trim().nullable().optional(),
  rows: z.array(factsRowSchema).min(1),
}).superRefine((value, context) => {
  const positions = new Set<number>();
  for (const row of value.rows) {
    if (positions.has(row.position)) context.addIssue({ code: "custom", message: `Facts position 重复：${row.position}` });
    positions.add(row.position);
  }
  for (const row of value.rows) {
    if (row.parentPosition !== null && row.parentPosition !== undefined && !positions.has(row.parentPosition)) {
      context.addIssue({ code: "custom", message: `Facts parentPosition 不存在：${row.parentPosition}` });
    }
  }
});

export const productBatchSchema = z.object({
  schemaVersion: z.literal("2.0"),
  products: z.array(normalizedProductSchema),
  facts: z.array(productFactsSchema).default([]),
}).superRefine((value, context) => {
  const productKeys = new Set<string>();
  for (const product of value.products) {
    const key = `${product.channel}:${product.externalId}`;
    if (productKeys.has(key)) context.addIssue({ code: "custom", message: `产品挂牌重复：${key}` });
    productKeys.add(key);
  }
  const factsKeys = new Set<string>();
  for (const facts of value.facts) {
    const key = `${facts.channel}:${facts.externalId}`;
    if (!productKeys.has(key)) context.addIssue({ code: "custom", message: `Facts 没有对应产品：${key}` });
    if (factsKeys.has(key)) context.addIssue({ code: "custom", message: `Facts 重复：${key}` });
    factsKeys.add(key);
  }
});

export const processingResultSchema = z.object({
  status: z.enum(["complete", "needs_review", "failed"]),
  summary: z.string().min(1),
  reasonCode: z.string().nullable().optional(),
  batch: productBatchSchema,
});

export type NormalizedProduct = z.infer<typeof normalizedProductSchema>;
export type ProductFacts = z.infer<typeof productFactsSchema>;
export type ProductBatch = z.infer<typeof productBatchSchema>;

type DbRow = Record<string, unknown>;

export interface ProductDbResult<T extends DbRow = DbRow> {
  rows: T[];
  rowCount?: number | null;
}

export interface ProductDbClient {
  query<T extends DbRow = DbRow>(sql: string, values?: unknown[]): Promise<ProductDbResult<T>>;
  release(): void;
}

export interface ProductDbPool {
  query<T extends DbRow = DbRow>(sql: string, values?: unknown[]): Promise<ProductDbResult<T>>;
  connect(): Promise<ProductDbClient>;
  end(): Promise<void>;
}

interface ProductWriteResult {
  channel: string;
  externalId: string;
  productId: string;
  companyId: string;
  listingId: string;
  matchedBy: "external_id" | "url" | "created";
  factsHash: string | null;
}

interface ListingRow extends DbRow {
  id: string;
  product_id: string;
  company_id: string | null;
  external_id: string | null;
  url_normalized: string | null;
  first_seen_at: Date | string | null;
  last_seen_at: Date | string | null;
  latest_snapshot_at: Date | string | null;
  observed_formula_at: Date | string | null;
}

interface IngredientRow extends DbRow {
  id: string;
  group_id: string | null;
}

interface ResolvedFactsRow {
  row: ProductFacts["rows"][number];
  ingredientId: string;
  key: string;
}

export function normalizeDomain(value: string) {
  const trimmed = value.trim();
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return trimmed.toLowerCase().replace(/^www\./, "").split("/")[0]!;
  }
}

export function normalizeListingUrl(value: string | null | undefined) {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${pathname}`.toLowerCase();
  } catch {
    return value.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[?#]/)[0]!.replace(/\/+$/, "").toLowerCase();
  }
}

export function parsePriceString(raw: string | null | undefined) {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.,-]/g, "");
  if (!cleaned) return null;
  const normalized = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned) ? cleaned.replace(/,/g, "") : cleaned;
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 ? normalized : null;
}

export function convertToMg(value: number | null | undefined, unit: string | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  switch ((unit ?? "").trim().toLowerCase()) {
    case "mg": return value;
    case "g":
    case "gram":
    case "grams": return value * 1000;
    case "mcg":
    case "µg":
    case "ug": return value / 1000;
    case "kg": return value * 1_000_000;
    default: return null;
  }
}

function normalizedNumber(value: number | null) {
  return value === null || !Number.isFinite(value) ? "" : String(Number(value));
}

export function computeFactsHash(rows: Array<{
  key: string;
  amountMg: number | null;
  dvPercent: number | null;
  isActive: boolean;
  parentKey: string;
}>, serving: { servingSize: number | null; servingUnit: string | null }) {
  const sorted = [...rows].sort((left, right) => {
    if (left.parentKey !== right.parentKey) return left.parentKey < right.parentKey ? -1 : 1;
    if (left.key !== right.key) return left.key < right.key ? -1 : 1;
    return (left.amountMg ?? -1) - (right.amountMg ?? -1);
  });
  const parts = sorted.map((row) =>
    `${row.parentKey}>${row.key}:${normalizedNumber(row.amountMg)}:${normalizedNumber(row.dvPercent)}:${row.isActive ? 1 : 0}`,
  );
  parts.push(`serving:${normalizedNumber(serving.servingSize)}:${(serving.servingUnit ?? "").trim().toLowerCase()}:`);
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function ingredientName(value: NormalizedProduct["mainIngredients"][number]) {
  return typeof value === "string" ? value.trim() : value.name.trim();
}

function listingAttrs(product: NormalizedProduct) {
  return {
    ...(product.variantAttrs ?? {}),
    sku: product.sku,
    sku_missing: product.skuMissing,
    ...(product.family ? {
      family_parent_external_id: product.family.parentExternalId,
      family_label: product.family.label,
    } : {}),
  };
}

function asDate(value: Date | string | null) {
  return value ? new Date(value) : null;
}

function isNewer(incoming: string, existing: Date | string | null) {
  const current = asDate(existing);
  return !current || new Date(incoming) > current;
}

async function findCompanyByDomain(client: ProductDbClient, rawDomain: string) {
  const domain = normalizeDomain(rawDomain);
  const result = await client.query<{ id: string; name: string }>(
    `select c.id,c.name
       from company c
      where lower(split_part(regexp_replace(trim(coalesce(c.website,'')), '^(https?://)?(www\\.)?', '', 'i'), '/', 1))=$1
         or exists (
           select 1 from unnest(coalesce(c.subdomains,'{}'::text[])) item
            where lower(split_part(regexp_replace(trim(item), '^(https?://)?(www\\.)?', '', 'i'), '/', 1))=$1
         )
      order by case when lower(split_part(regexp_replace(trim(coalesce(c.website,'')), '^(https?://)?(www\\.)?', '', 'i'), '/', 1))=$1 then 0 else 1 end,
               c.created_at,c.id
      limit 2`,
    [domain],
  );
  if (result.rows.length === 0) throw new Error(`找不到域名为 ${domain} 的公司`);
  if (result.rows.length > 1) throw new Error(`域名 ${domain} 匹配到多个公司`);
  return result.rows[0]!;
}

async function findOrCreateIngredient(client: ProductDbClient, rawName: string) {
  const name = rawName.trim();
  if (!name || name.length > 200) throw new Error(`成分名称无效：${rawName}`);
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [`ingredient:${name.toLowerCase()}`]);
  const found = await client.query<IngredientRow>(
    "select id,group_id from ingredient where lower(name)=lower($1) order by created_at,id limit 1",
    [name],
  );
  if (found.rows[0]) return found.rows[0];
  const created = await client.query<IngredientRow>(
    "insert into ingredient(name) values($1) returning id,group_id",
    [name],
  );
  if (!created.rows[0]) throw new Error(`成分创建失败：${name}`);
  return created.rows[0];
}

async function findListing(client: ProductDbClient, product: NormalizedProduct) {
  const byExternalId = await client.query<ListingRow>(
    `select pc.id,pc.product_id,p.company_id,pc.external_id,pc.url_normalized,
            pc.first_seen_at,pc.last_seen_at,pc.latest_snapshot_at,pc.observed_formula_at
       from product_channel pc join product p on p.id=pc.product_id
      where pc.channel=$1 and pc.external_id=$2 limit 1`,
    [product.channel, product.externalId],
  );
  if (byExternalId.rows[0]) return { row: byExternalId.rows[0], matchedBy: "external_id" as const };
  // externalId 是当前契约的必填稳定锚点。同一路径的 Shopify/Amazon 变体
  // 可能只在 query 或渠道 ID 上不同，不能在 externalId 未命中后再按 URL 合并。
  return null;
}

async function createProduct(client: ProductDbClient, companyId: string, product: NormalizedProduct) {
  const created = await client.query<{ id: string }>(
    `insert into product
       (name,company_id,source,website,original_product_url,provenance,first_seen_at,last_seen_at)
     values($1,$2,$3,$4,$4,$5::jsonb,$6,$6)
     returning id`,
    [
      product.productName,
      companyId,
      product.source,
      product.productUrl,
      JSON.stringify({ source: product.source, channel: product.channel, externalId: product.externalId }),
      product.capturedAt,
    ],
  );
  if (!created.rows[0]) throw new Error("产品创建失败");
  return created.rows[0].id;
}

async function upsertListing(
  client: ProductDbClient,
  productId: string,
  product: NormalizedProduct,
  existing: ListingRow | null,
) {
  const values = [
    productId,
    product.channel,
    product.externalId,
    product.productName,
    normalizeListingUrl(product.sourceUrl),
    product.sourceUrl,
    JSON.stringify(listingAttrs(product)),
    product.capturedAt,
    parsePriceString(product.price),
    product.currency ?? null,
    product.rating ?? null,
    product.reviewCount ?? null,
  ];

  if (!existing) {
    const inserted = await client.query<{ id: string }>(
      `insert into product_channel
         (product_id,channel,external_id,title_raw,url_normalized,website,original_product_url,attrs,
          first_seen_at,last_seen_at,status,latest_price,latest_currency,latest_rating,latest_review_count,latest_snapshot_at)
       values($1,$2,$3,$4,$5,$6,$6,$7::jsonb,$8,$8,'active',$9,$10,$11,$12,$8)
       on conflict(channel,external_id) where external_id is not null do nothing
       returning id`,
      values,
    );
    if (inserted.rows[0]) return inserted.rows[0].id;
    const raced = await client.query<{ id: string; product_id: string }>(
      "select id,product_id from product_channel where channel=$1 and external_id=$2 limit 1",
      [product.channel, product.externalId],
    );
    if (!raced.rows[0]) throw new Error("挂牌创建后无法回读");
    if (raced.rows[0].product_id !== productId) throw new Error("挂牌并发写入到了另一个产品");
    return raced.rows[0].id;
  }

  await client.query(
    `update product_channel set
       title_raw=$2,url_normalized=coalesce($3,url_normalized),website=$4,original_product_url=$4,attrs=$5::jsonb,
       first_seen_at=coalesce(least(first_seen_at,$6::timestamptz),first_seen_at,$6::timestamptz),
       last_seen_at=coalesce(greatest(last_seen_at,$6::timestamptz),last_seen_at,$6::timestamptz),status='active',
       latest_price=case when $6::timestamptz>coalesce(latest_snapshot_at,'epoch'::timestamptz) then $7 else latest_price end,
       latest_currency=case when $6::timestamptz>coalesce(latest_snapshot_at,'epoch'::timestamptz) then $8 else latest_currency end,
       latest_rating=case when $6::timestamptz>coalesce(latest_snapshot_at,'epoch'::timestamptz) then $9 else latest_rating end,
       latest_review_count=case when $6::timestamptz>coalesce(latest_snapshot_at,'epoch'::timestamptz) then $10 else latest_review_count end,
       latest_snapshot_at=greatest(coalesce(latest_snapshot_at,'epoch'::timestamptz),$6::timestamptz),updated_at=now()
     where id=$1`,
    [
      existing.id,
      product.productName,
      normalizeListingUrl(product.sourceUrl),
      product.sourceUrl,
      JSON.stringify(listingAttrs(product)),
      product.capturedAt,
      parsePriceString(product.price),
      product.currency ?? null,
      product.rating ?? null,
      product.reviewCount ?? null,
    ],
  );
  return existing.id;
}

async function writeProductRelations(client: ProductDbClient, productId: string, listingId: string, product: NormalizedProduct) {
  await client.query(
    `insert into listing_snapshot
       (listing_id,captured_at,source,price,currency,list_price,rating,review_count,sales_rank,in_stock,units_sold,units_sold_period)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict(listing_id,captured_at,source) do update set
       units_sold=coalesce(excluded.units_sold,listing_snapshot.units_sold),
       units_sold_period=coalesce(excluded.units_sold_period,listing_snapshot.units_sold_period),
       rating=excluded.rating,review_count=excluded.review_count`,
    [
      listingId,
      product.capturedAt,
      product.source,
      parsePriceString(product.price),
      product.currency ?? null,
      parsePriceString(product.listPrice),
      product.rating ?? null,
      product.reviewCount ?? null,
      product.salesRank ?? null,
      product.inStock ?? null,
      product.unitsSold ?? null,
      product.unitsSoldPeriod ?? null,
    ],
  );

  for (const imageUrl of new Set(product.images)) {
    await client.query(
      `insert into product_image(product_id,listing_id,channel,image_url)
       select $1,$2,$3,$4 where not exists(
         select 1 from product_image where product_id=$1 and image_url=$4
       )`,
      [productId, listingId, product.channel, imageUrl],
    );
  }

  for (const name of new Set(product.healthFunctions)) {
    const linked = await client.query<{ id: string }>(
      `insert into product_health_function(product_id,health_function_id)
       select $1,id from health_function where lower(name)=lower($2)
       on conflict do nothing returning health_function_id as id`,
      [productId, name],
    );
    if (!linked.rows[0]) {
      const exists = await client.query<{ id: string }>("select id from health_function where lower(name)=lower($1) limit 1", [name]);
      if (!exists.rows[0]) throw new Error(`功效词表不存在：${name}`);
    }
  }

  if (product.productForm.toLowerCase() !== "other") {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`form:${product.productForm.toLowerCase()}`]);
    const found = await client.query<{ id: string }>("select id from form where lower(name)=lower($1) order by created_at,id limit 1", [product.productForm]);
    const formId = found.rows[0]?.id ?? (await client.query<{ id: string }>("insert into form(name) values($1) returning id", [product.productForm])).rows[0]?.id;
    if (!formId) throw new Error(`剂型创建失败：${product.productForm}`);
    await client.query("insert into product_form(product_id,form_id) values($1,$2) on conflict do nothing", [productId, formId]);
  }

  for (const name of new Set(product.mainIngredients.map(ingredientName))) {
    const ingredient = await findOrCreateIngredient(client, name);
    await client.query(
      "insert into product_ingredient(product_id,ingredient_id) values($1,$2) on conflict do nothing",
      [productId, ingredient.id],
    );
  }
}

async function writeFacts(
  client: ProductDbClient,
  productId: string,
  listingId: string,
  listing: ListingRow | null,
  facts: ProductFacts,
) {
  const resolved: ResolvedFactsRow[] = [];
  for (const row of facts.rows) {
    const ingredient = await findOrCreateIngredient(client, row.name);
    resolved.push({ row, ingredientId: ingredient.id, key: ingredient.group_id ? `g:${ingredient.group_id}` : `i:${ingredient.id}` });
  }
  const keyByPosition = new Map(resolved.map((item) => [item.row.position, item.key]));
  const hash = computeFactsHash(resolved.map((item) => ({
    key: item.key,
    amountMg: convertToMg(item.row.amountValue, item.row.amountUnit),
    dvPercent: item.row.dvPercent ?? null,
    isActive: item.row.isActive,
    parentKey: item.row.parentPosition === null || item.row.parentPosition === undefined
      ? ""
      : (keyByPosition.get(item.row.parentPosition) ?? ""),
  })), {
    servingSize: facts.servingSize ?? null,
    servingUnit: facts.servingUnit ?? null,
  });

  const existingFormula = await client.query<{ id: string }>("select id from formula where hash=$1 limit 1", [hash]);
  let formulaId = existingFormula.rows[0]?.id;
  let formulaCreated = false;
  if (!formulaId) {
    const inserted = await client.query<{ id: string }>(
      `insert into formula(hash,serving_size,serving_unit) values($1,$2,$3)
       on conflict(hash) do nothing returning id`,
      [hash, facts.servingSize ?? null, facts.servingUnit ?? null],
    );
    formulaId = inserted.rows[0]?.id;
    formulaCreated = Boolean(formulaId);
    if (!formulaId) formulaId = (await client.query<{ id: string }>("select id from formula where hash=$1 limit 1", [hash])).rows[0]?.id;
  }
  if (!formulaId) throw new Error("Formula 创建后无法回读");

  if (formulaCreated) {
    const idByPosition = new Map<number, string>();
    for (const item of resolved.filter((value) => value.row.parentPosition === null || value.row.parentPosition === undefined)) {
      const inserted = await client.query<{ id: string }>(
        `insert into formula_ingredient
           (formula_id,ingredient_id,raw_text,amount_value,amount_unit,amount_mg,dv_percent,position,is_active,parent_id)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,null) returning id`,
        [
          formulaId,
          item.ingredientId,
          item.row.name,
          item.row.amountValue ?? null,
          item.row.amountUnit ?? null,
          convertToMg(item.row.amountValue, item.row.amountUnit),
          item.row.dvPercent ?? null,
          item.row.position,
          item.row.isActive,
        ],
      );
      if (!inserted.rows[0]) throw new Error(`Formula 顶层行创建失败：${item.row.position}`);
      idByPosition.set(item.row.position, inserted.rows[0].id);
    }
    for (const item of resolved.filter((value) => value.row.parentPosition !== null && value.row.parentPosition !== undefined)) {
      const parentId = idByPosition.get(item.row.parentPosition!);
      if (!parentId) throw new Error(`Formula 父行不存在：${item.row.parentPosition}`);
      await client.query(
        `insert into formula_ingredient
           (formula_id,ingredient_id,raw_text,amount_value,amount_unit,amount_mg,dv_percent,position,is_active,parent_id)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          formulaId,
          item.ingredientId,
          item.row.name,
          item.row.amountValue ?? null,
          item.row.amountUnit ?? null,
          convertToMg(item.row.amountValue, item.row.amountUnit),
          item.row.dvPercent ?? null,
          item.row.position,
          item.row.isActive,
          parentId,
        ],
      );
    }
  }

  const prior = await client.query<{ observed_at: Date | string }>(
    "select observed_at from formula_observation where product_id=$1 order by observed_at desc limit 1",
    [productId],
  );
  await client.query(
    `insert into formula_observation(product_id,formula_id,observed_at,listing_id,source,confidence)
     select $1,$2,$3,$4,$5,$6 where not exists(
       select 1 from formula_observation where product_id=$1 and formula_id=$2 and observed_at=$3
     )`,
    [productId, formulaId, facts.capturedAt, listingId, facts.source, facts.confidence],
  );

  const priorTime = asDate(prior.rows[0]?.observed_at ?? null)?.getTime();
  if (priorTime === undefined || new Date(facts.capturedAt).getTime() >= priorTime) {
    await client.query(
      `update product set formula_id=$2,servings_per_container=coalesce($3,servings_per_container),
         net_content=coalesce($4,net_content),last_seen_at=coalesce(greatest(last_seen_at,$5::timestamptz),last_seen_at,$5::timestamptz),updated_at=now()
       where id=$1`,
      [productId, formulaId, facts.servingsPerContainer ?? null, facts.netContent ?? null, facts.capturedAt],
    );
  }
  await client.query(
    `insert into product_ingredient(product_id,ingredient_id)
     select $1,ingredient_id from formula_ingredient where formula_id=$2 and is_active=true
     on conflict do nothing`,
    [productId, formulaId],
  );
  if (!listing?.observed_formula_at || isNewer(facts.capturedAt, listing.observed_formula_at)) {
    await client.query(
      "update product_channel set observed_formula_id=$2,observed_formula_at=$3,updated_at=now() where id=$1",
      [listingId, formulaId, facts.capturedAt],
    );
  }
  return hash;
}

async function writeOne(client: ProductDbClient, product: NormalizedProduct, facts: ProductFacts | undefined): Promise<ProductWriteResult> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [`listing:${product.channel}:${product.externalId}`]);
  const company = await findCompanyByDomain(client, product.domain);
  const listingMatch = await findListing(client, product);
  if (listingMatch?.row.company_id && listingMatch.row.company_id !== company.id) {
    throw new Error(`挂牌已属于其他公司：${listingMatch.row.company_id}`);
  }

  const productId = listingMatch?.row.product_id ?? await createProduct(client, company.id, product);
  if (listingMatch?.row) {
    await client.query(
      `update product set name=$2,company_id=coalesce(company_id,$3),website=$4,original_product_url=$4,
         first_seen_at=coalesce(least(first_seen_at,$5::timestamptz),first_seen_at,$5::timestamptz),
         last_seen_at=coalesce(greatest(last_seen_at,$5::timestamptz),last_seen_at,$5::timestamptz),updated_at=now()
       where id=$1`,
      [productId, product.productName, company.id, product.productUrl, product.capturedAt],
    );
  }
  const listingId = await upsertListing(client, productId, product, listingMatch?.row ?? null);
  await writeProductRelations(client, productId, listingId, product);
  const factsHash = facts ? await writeFacts(client, productId, listingId, listingMatch?.row ?? null, facts) : null;
  return {
    channel: product.channel,
    externalId: product.externalId,
    productId,
    companyId: company.id,
    listingId,
    matchedBy: listingMatch?.matchedBy ?? "created",
    factsHash,
  };
}

function familyLabel(attrs: unknown) {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return null;
  const value = attrs as Record<string, unknown>;
  const parts = [value.family_label, value.label, value.pack]
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(parts)].join(" · ") || null;
}

async function applyFamilies(client: ProductDbClient, records: ProductWriteResult[], products: NormalizedProduct[]) {
  const productByListing = new Map(products.map((product) => [`${product.channel}:${product.externalId}`, product]));
  const groups = new Map<string, { companyId: string; channel: string; parentExternalId: string; records: ProductWriteResult[] }>();
  for (const record of records) {
    const product = productByListing.get(`${record.channel}:${record.externalId}`);
    const parentExternalId = product?.family?.parentExternalId;
    if (!product?.family || !parentExternalId) continue;
    const key = `${record.companyId}:${record.channel}:${parentExternalId}`;
    const group = groups.get(key) ?? { companyId: record.companyId, channel: record.channel, parentExternalId, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`family:${group.companyId}:${group.channel}:${group.parentExternalId}`]);
    const memberExternalIds = [...new Set([...group.records.map((record) => record.externalId), group.parentExternalId])];
    const candidates = await client.query<{
      product_id: string;
      product_name: string;
      external_id: string;
      attrs: unknown;
      family_id: string | null;
    }>(
      `select distinct on (p.id) p.id product_id,p.name product_name,pc.external_id,pc.attrs,p.family_id
         from product_channel pc join product p on p.id=pc.product_id
        where p.company_id=$1 and pc.channel=$2
          and (pc.external_id=any($3::text[]) or pc.attrs->>'family_parent_external_id'=$4)
        order by p.id,(pc.external_id=$4) desc,pc.created_at`,
      [group.companyId, group.channel, memberExternalIds, group.parentExternalId],
    );
    if (new Set(candidates.rows.map((row) => row.product_id)).size < 2) continue;

    const existingFamilyIds = [...new Set(candidates.rows.map((row) => row.family_id).filter((id): id is string => Boolean(id)))];
    if (existingFamilyIds.length > 1) throw new Error(`家族 ${group.parentExternalId} 已跨越多个 product_family`);
    let familyId = existingFamilyIds[0];
    if (!familyId) {
      const requestedName = group.records
        .map((record) => productByListing.get(`${record.channel}:${record.externalId}`)?.family?.name)
        .find((name): name is string => Boolean(name));
      const representative = candidates.rows.find((row) => row.external_id === group.parentExternalId)
        ?? [...candidates.rows].sort((left, right) => left.product_name.length - right.product_name.length || left.product_name.localeCompare(right.product_name))[0]!;
      let name = requestedName ?? representative.product_name.trim();
      const collision = await client.query<{ id: string; member_count: string }>(
        `select pf.id,count(p.id)::text member_count
           from product_family pf left join product p on p.family_id=pf.id
          where pf.company_id=$1 and lower(pf.name)=lower($2)
          group by pf.id limit 1`,
        [group.companyId, name],
      );
      if (collision.rows[0] && Number(collision.rows[0].member_count) > 0) {
        name = `${name} · ${group.channel} ${group.parentExternalId}`;
      }
      const inserted = await client.query<{ id: string }>(
        `insert into product_family(company_id,name) values($1,$2)
         on conflict(company_id,name) do update set updated_at=now() returning id`,
        [group.companyId, name],
      );
      familyId = inserted.rows[0]?.id;
    }
    if (!familyId) throw new Error(`产品家族创建失败：${group.parentExternalId}`);
    for (const member of candidates.rows) {
      await client.query(
        "update product set family_id=$2,family_label=$3,updated_at=now() where id=$1",
        [member.product_id, familyId, familyLabel(member.attrs)],
      );
    }
  }
}

export class SupplySmartDatabase {
  constructor(private readonly pool: ProductDbPool) {}

  static fromDatabaseUrl(databaseUrl: string) {
    return new SupplySmartDatabase(new pg.Pool({ connectionString: databaseUrl, max: 4 }) as unknown as ProductDbPool);
  }

  async loadHealthFunctions() {
    const result = await this.pool.query<{ name: string }>("select name from health_function where trim(name)<>'' order by name");
    return result.rows.map((row) => row.name);
  }

  async resolveCompanyDomain(brand: string) {
    const normalizeBrand = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const keys = [...new Set([
      normalizeBrand(brand),
      normalizeBrand(brand.replace(/\b(?:official|store|shop)\b/gi, " ")),
    ].filter(Boolean))];
    const result = await this.pool.query<{ id: string; website: string | null }>(
      `select id,website from company
        where website is not null and (
          regexp_replace(lower(name),'[^a-z0-9]','','g')=any($1::text[])
          or regexp_replace(lower(coalesce(canonical_name,'')),'[^a-z0-9]','','g')=any($1::text[])
        )
        order by case when regexp_replace(lower(name),'[^a-z0-9]','','g')=$2 then 0 else 1 end,created_at,id
        limit 2`,
      [keys, keys[0]],
    );
    if (result.rows.length !== 1 || !result.rows[0]?.website) return null;
    return normalizeDomain(result.rows[0].website);
  }

  async ingestAndValidate(rawBatch: unknown) {
    const batch = productBatchSchema.parse(rawBatch);
    const factsByListing = new Map(batch.facts.map((facts) => [`${facts.channel}:${facts.externalId}`, facts]));
    const records: ProductWriteResult[] = [];
    const problems: string[] = [];

    for (const product of batch.products) {
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        const result = await writeOne(client, product, factsByListing.get(`${product.channel}:${product.externalId}`));
        await client.query("commit");
        records.push(result);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        problems.push(`${product.channel}:${product.externalId}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        client.release();
      }
    }

    if (records.length > 0) {
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        await applyFamilies(client, records, batch.products);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        problems.push(`product_family: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        client.release();
      }
    }

    const verified: ProductWriteResult[] = [];
    for (const record of records) {
      const readback = await this.pool.query<{
        listing_id: string;
        product_id: string;
        channel: string;
        external_id: string;
        attrs: Record<string, unknown> | null;
        formula_id: string | null;
      }>(
        `select pc.id listing_id,p.id product_id,pc.channel,pc.external_id,pc.attrs,p.formula_id
           from product_channel pc join product p on p.id=pc.product_id
          where pc.channel=$1 and pc.external_id=$2 limit 1`,
        [record.channel, record.externalId],
      );
      const row = readback.rows[0];
      if (!row || row.product_id !== record.productId) {
        problems.push(`${record.channel}:${record.externalId}: 入库回读不一致`);
        continue;
      }
      const expected = productByKey(batch.products, record.channel, record.externalId);
      if (expected && (row.attrs?.sku ?? null) !== expected.sku) {
        problems.push(`${record.channel}:${record.externalId}: SKU 回读不一致`);
        continue;
      }
      if (record.factsHash && !row.formula_id) {
        problems.push(`${record.channel}:${record.externalId}: Formula 回读缺失`);
        continue;
      }
      verified.push(record);
    }

    verified.sort((left, right) => `${left.channel}:${left.externalId}`.localeCompare(`${right.channel}:${right.externalId}`));
    return {
      loaded: records.length,
      verified: verified.length,
      problems,
      records: verified,
      readbackHash: createHash("sha256").update(JSON.stringify(verified)).digest("hex"),
    };
  }

  async close() {
    await this.pool.end();
  }
}

function productByKey(products: NormalizedProduct[], channel: string, externalId: string) {
  return products.find((product) => product.channel === channel && product.externalId === externalId);
}
