import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProductUnifyResult } from "../product-unify.js";
import type { ChannelFactsResult } from "./stages.js";

/**
 * "没有公司"的产品旁库。
 *
 * 产品库入库要求品牌能唯一映射到一家公司；映射不上的产品数据其实是完整的（标题、价格、
 * 成分表都在），以前只在 quarantine.json 里留一行 key/标题/URL，正文散落在各 run 目录里，
 * run 目录清理后就没了。09-04 决定：这类产品不进产品库，**完整**存进 mini 本地的一个
 * SQLite 文件，和产品库彻底分开；等这一轮跑完再统一整理品牌→公司。
 *
 * 存的是重新归一化所需的全部原料（抓取原文、语义结果、Unify 结果、成分表），外加几列
 * 扁平字段方便直接查。以后公司认领后，用 hooks.normalize 按真实 domain 再算一遍即可，
 * 不需要重抓、不需要重新 OCR。
 */
export interface NoCompanyProductEntry {
  channel: string;
  externalId: string;
  brand: string | null;
  runId: string;
  sourceUrl: string;
  title: string;
  productUrl: string;
  capturedAt: string | null;
  sku: string | null;
  price: string | null;
  ingredients: string[];
  factsRows: number;
  raw: unknown;
  semantic: unknown;
  unified: ProductUnifyResult | null;
  facts: ChannelFactsResult | null;
}

export class NoCompanyStore {
  private readonly db: DatabaseSync;

  constructor(readonly filename: string) {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      pragma journal_mode=WAL;
      pragma busy_timeout=5000;
      create table if not exists no_company_product (
        channel text not null,
        external_id text not null,
        brand text,
        run_id text not null,
        source_url text not null,
        title text not null,
        product_url text not null,
        captured_at text,
        sku text,
        price text,
        ingredients_json text not null,
        facts_rows integer not null default 0,
        raw_json text not null,
        semantic_json text not null,
        unified_json text,
        facts_json text,
        first_seen_at text not null,
        updated_at text not null,
        primary key (channel, external_id)
      );
      create index if not exists no_company_product_brand_idx on no_company_product(channel, brand);
      create index if not exists no_company_product_run_idx on no_company_product(run_id);
    `);
  }

  /** 同一 (channel, externalId) 反复出现时以最新一次为准，first_seen_at 保留最早的。 */
  upsert(entry: NoCompanyProductEntry) {
    const now = new Date().toISOString();
    this.db.prepare(`
      insert into no_company_product(
        channel, external_id, brand, run_id, source_url, title, product_url, captured_at, sku, price,
        ingredients_json, facts_rows, raw_json, semantic_json, unified_json, facts_json, first_seen_at, updated_at
      ) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(channel, external_id) do update set
        brand=excluded.brand, run_id=excluded.run_id, source_url=excluded.source_url,
        title=excluded.title, product_url=excluded.product_url, captured_at=excluded.captured_at,
        sku=excluded.sku, price=excluded.price, ingredients_json=excluded.ingredients_json,
        facts_rows=excluded.facts_rows, raw_json=excluded.raw_json, semantic_json=excluded.semantic_json,
        unified_json=excluded.unified_json, facts_json=excluded.facts_json, updated_at=excluded.updated_at
    `).run(
      entry.channel, entry.externalId, entry.brand, entry.runId, entry.sourceUrl, entry.title, entry.productUrl,
      entry.capturedAt, entry.sku, entry.price, JSON.stringify(entry.ingredients), entry.factsRows,
      JSON.stringify(entry.raw), JSON.stringify(entry.semantic),
      entry.unified ? JSON.stringify(entry.unified) : null,
      entry.facts ? JSON.stringify(entry.facts) : null,
      now, now,
    );
  }

  upsertMany(entries: NoCompanyProductEntry[]) {
    if (entries.length === 0) return 0;
    this.db.exec("begin immediate");
    try {
      for (const entry of entries) this.upsert(entry);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    return entries.length;
  }

  count() {
    return Number((this.db.prepare("select count(*) n from no_company_product").get() as { n: number }).n);
  }

  /** 按渠道 + 品牌汇总，整理品牌→公司映射时直接看这个。 */
  summary() {
    return this.db.prepare(
      `select channel, coalesce(brand,'') brand, count(*) n, sum(facts_rows > 0) with_facts
       from no_company_product group by channel, brand order by n desc`,
    ).all() as Array<{ channel: string; brand: string; n: number; with_facts: number }>;
  }

  close() {
    this.db.close();
  }
}
