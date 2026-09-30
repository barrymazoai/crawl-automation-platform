/**
 * 把公司与产品的权威数据同步到 staging 的参考表，供品牌解析线自给自足地查询。
 *
 * 为什么落在 ref_company / ref_product 而不是直接进 company / product：
 * staging 的 product 表是入库流程做身份归并与下架判定的地方，带 identity_state、
 * variant_key 那一整套机器。参考库里的产品没有这些字段，灌进去会造成错误归并和误下架。
 * 参考表是只读的证据来源，跟入库链路完全隔离。
 *
 * 用法：tsx scripts/sync-reference-catalog.ts [--source railway_local_new]
 */
import pg from "pg";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const sourceDb = arg("source", "railway_local_new");
const targetDb = arg("target", "product_staging");

const connect = (db: string) => {
  const url = new URL(process.env.PRODUCT_DATABASE_URL!);
  url.pathname = `/${db}`;
  url.search = "";
  return new pg.Pool({ connectionString: url.toString(), max: 2 });
};

const SCHEMA = `
create table if not exists ref_company (
  id uuid primary key, name text, canonical_name text, website text, canonical_website text,
  description text, keywords text[], is_nutrition boolean, synced_at timestamptz not null default now()
);
create table if not exists ref_product (
  id uuid primary key, company_id uuid, name text, website text, original_product_url text,
  source text, sales_channels text[], synced_at timestamptz not null default now()
);
create index if not exists ref_product_company_idx on ref_product(company_id);
create index if not exists ref_company_website_idx on ref_company(coalesce(canonical_website, website));
`;

/** 分批搬，避免一次把几万行塞进一条 insert。 */
async function copy(source: pg.Pool, target: pg.Pool, table: string, columns: string[], selectSql: string) {
  const { rows } = await source.query(selectSql);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(",");
  const updates = columns.slice(1).map((c) => `${c}=excluded.${c}`).join(",");
  const batchSize = 500;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const client = await target.connect();
    try {
      await client.query("begin");
      for (const row of batch) {
        await client.query(
          `insert into ${table}(${columns.join(",")}) values(${placeholders})
           on conflict(id) do update set ${updates}, synced_at=now()`,
          columns.map((c) => row[c] ?? null));
      }
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }
  return rows.length;
}

async function main() {
  const source = connect(sourceDb);
  const target = connect(targetDb);
  console.log(`同步 ${sourceDb} → ${targetDb} 的参考表`);
  await target.query(SCHEMA);

  const companies = await copy(source, target, "ref_company",
    ["id", "name", "canonical_name", "website", "canonical_website", "description", "keywords", "is_nutrition"],
    `select id, name, canonical_name, website, canonical_website, description, keywords, is_nutrition from company`);
  console.log(`  公司 ${companies} 家`);

  const products = await copy(source, target, "ref_product",
    ["id", "company_id", "name", "website", "original_product_url", "source", "sales_channels"],
    `select id, company_id, name, website, original_product_url, source, sales_channels from product`);
  console.log(`  产品 ${products} 个`);

  const check = (await target.query(
    `select (select count(*)::int from ref_company) companies,
            (select count(*)::int from ref_product) products,
            (select count(distinct company_id)::int from ref_product where company_id is not null) with_products`)).rows[0];
  console.log(`\n参考表现状: 公司 ${check.companies} · 产品 ${check.products} · 有产品的公司 ${check.with_products}（${Math.round(check.with_products / check.companies * 100)}%）`);
  await source.end(); await target.end();
}
main().catch((error) => { console.error(error); process.exit(1); });
