/**
 * 把 Swanson 全部品牌排进抓取队列。
 * 品牌清单从站方接口的 brand facet 实时取——422 个品牌的商品数合计等于总商品数，
 * 是可自校验的全集，不用像 GNC 那样反复核验目录完不完整。
 */
import pg from "pg";
import { PipelineRepository } from "../src/repository.js";

const HEADERS = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36" };

async function loadBrands() {
  const html = await (await fetch("https://www.swansonvitamins.com/collections/all", { headers: HEADERS })).text();
  const apiKey = html.match(/constructorApiKey\s*=\s*['"]([^'"]+)/)?.[1];
  if (!apiKey) throw new Error("拿不到 constructorApiKey，页面结构可能变了");
  const url = new URL("https://ac.cnstrc.com/browse/group_id/0");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("num_results_per_page", "1");
  const data: any = await (await fetch(url.toString(), { headers: HEADERS })).json();
  const facet = (data.response.facets ?? []).find((entry: any) => entry.name === "brand");
  if (!facet) throw new Error("接口里没有 brand facet");
  const options: { value: string; count: number }[] = facet.options ?? [];
  const total = Number(data.response.total_num_results);
  const sum = options.reduce((acc, option) => acc + (option.count ?? 0), 0);
  console.log(`品牌 ${options.length} 个 · 商品合计 ${sum} · 站点自报 ${total}${sum === total ? "（吻合）" : "（不吻合，注意）"}`);
  return options.sort((a, b) => (a.count ?? 0) - (b.count ?? 0));   // 小品牌先跑，早出结果
}

async function main() {
  const brands = await loadBrands();
  const u = new URL(process.env.PRODUCT_DATABASE_URL!); u.pathname = "/crawl_control_plane_v2"; u.search = "";
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  const repository = new PipelineRepository(pool);

  const submitted = new Set((await pool.query<{ url: string }>(
    "select url from pipeline_source where adapter='swanson' and url like '%facet.brand=%'")).rows
    .map((row) => decodeURIComponent(new URL(row.url).searchParams.get("facet.brand") ?? "")));

  const pending = brands.filter((brand) => !submitted.has(brand.value));
  console.log(`已提交过 ${submitted.size} 个 · 本次提交 ${pending.length} 个`);

  let created = 0;
  for (const brand of pending) {
    const url = `https://www.swansonvitamins.com/collections/all?facet.brand=${encodeURIComponent(brand.value)}`;
    try {
      const result = await repository.createRuns({ urls: [url], mode: "one_off", scheduleTimezone: "Asia/Shanghai" });
      if (result.created.length) created += 1;
    } catch (error: any) { console.log(`  失败 ${brand.value}: ${error.message.slice(0, 60)}`); }
  }
  console.log(`\n已提交 ${created} 个品牌`);
  const queued = (await pool.query(
    `select count(*)::int n from pipeline_job j join pipeline_run r on r.id=j.run_id
     join pipeline_source s on s.id=r.source_id
     where j.stage='capture_catalog' and j.state in ('queued','retry_wait') and s.adapter='swanson'`)).rows[0];
  console.log(`Swanson 抓取队列: ${queued.n} 个品牌待抓`);
  await pool.end();
}
main().catch((error) => { console.error(error.message); process.exit(1); });
