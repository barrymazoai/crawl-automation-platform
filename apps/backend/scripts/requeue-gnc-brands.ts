/**
 * 把 GNC 品牌目录里还没抓成功的品牌全部重新入队（走 ScraperAPI worker）。
 *
 * 来源：pipeline_run 里 capture_catalog 处于 needs_review/failed 的 GNC 品牌 URL
 * （PerimeterX 时期 + 今天上午 innerText 误判那批），排除今天已经 capture 成功过的品牌。
 * 旧的 needs_review run 一并作废，免得复核队列里留着几百条已经无意义的挑战记录。
 *
 * 用法：npx tsx scripts/requeue-gnc-brands.ts          只列清单
 *       npx tsx scripts/requeue-gnc-brands.ts --apply  作废旧 run 并重提
 */
import pg from "pg";
import { PipelineRepository } from "../src/repository.js";

async function main() {
  const apply = process.argv.includes("--apply");
  const u = new URL(process.env.PRODUCT_DATABASE_URL!); u.pathname = "/crawl_control_plane_v2"; u.search = "";
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });

  const stale = (await pool.query<{ id: string; url: string }>(
    `select distinct r.id, s.url from pipeline_run r join pipeline_source s on s.id=r.source_id join pipeline_job j on j.run_id=r.id
     where s.adapter='gnc' and r.status='active' and s.url like 'https://www.gnc.com/brands/%'
       and j.stage='capture_catalog' and j.state in ('needs_review','failed')`)).rows;
  const succeeded = new Set((await pool.query<{ url: string }>(
    `select distinct s.url from pipeline_run r join pipeline_source s on s.id=r.source_id join pipeline_job j on j.run_id=r.id
     where s.adapter='gnc' and j.stage='capture_catalog' and j.state='completed' and j.completed_at > now() - interval '1 day'`)).rows.map((r) => r.url));
  const urls = [...new Set(stale.map((r) => r.url))].filter((url) => !succeeded.has(url)).sort();
  console.log(`待重排品牌 ${urls.length} 个（旧 run ${stale.length} 个；今天已抓成功、跳过 ${[...new Set(stale.map((r) => r.url))].length - urls.length} 个）`);
  console.log(urls.map((x) => x.replace("https://www.gnc.com/brands/", "").replace(/\/$/, "")).join("  "));
  if (!apply || !urls.length) { await pool.end(); return; }

  await pool.query(`update pipeline_run set status='abandoned', updated_at=now() where id = any($1::uuid[])`, [stale.map((r) => r.id)]);
  await pool.query(`update pipeline_review set status='resolved', resolution=$2, resolved_at=now() where run_id = any($1::uuid[]) and status='open'`,
    [stale.map((r) => r.id), "改走 ScraperAPI 重排新 run"]);
  const repository = new PipelineRepository(pool);
  let created = 0;
  for (const url of urls) created += (await repository.createRuns({ urls: [url], mode: "one_off", scheduleTimezone: "Asia/Shanghai" })).created.length;
  console.log(`\n已作废旧 run ${stale.length} 个 · 重新提交 ${created} 个`);
  await pool.end();
}
main().catch((error) => { console.error(error.message); process.exit(1); });
