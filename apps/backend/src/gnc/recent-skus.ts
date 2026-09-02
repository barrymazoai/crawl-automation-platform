import pg from "pg";

/**
 * 库里最近已见过的 GNC SKU 集合，用于跨 run 跳过重复抓取。
 *
 * 每次请求都要花 ScraperAPI 额度（GNC 域名 10 credits/次），同一个 SKU 在不同品牌 run、
 * 口味联动里会反复出现；库里 last_seen_at 在窗口内的就不再抓。只看成功入库的产品，
 * 被隔离/排除的不在 product 表里，自然会重抓。
 */
export async function loadRecentGncSkus(databaseUrl: string, withinDays = 30): Promise<Set<string>> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const rows = (await pool.query<{ url: string }>(
      `select original_product_url url from product
       where original_product_url like 'https://www.gnc.com/%' and last_seen_at > now() - make_interval(days => $1)`,
      [withinDays])).rows;
    const skus = new Set<string>();
    for (const { url } of rows) {
      const sku = url.match(/\/(\d{6})\.html/)?.[1];
      if (sku) skus.add(sku);
    }
    return skus;
  } finally { await pool.end(); }
}
