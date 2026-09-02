/**
 * 重排抓取数据已丢失的 Swanson run。
 *
 * 2026-09-02 一条误操作的 rsync 删掉了 WORK_ROOT 里已抓取、尚未处理文字的批次目录。
 * 这些 run 的 process_text 任务只会不断 ENOENT，必须作废后按原品牌 URL 重新提交。
 * 顺带把 capture 本身失败（failed）的 run 也重排。
 *
 * 用法：npx tsx scripts/requeue-swanson-lost.ts          只列清单
 *       npx tsx scripts/requeue-swanson-lost.ts --apply  作废旧 run 并重提
 */
import fs from "node:fs";
import pg from "pg";
import { PipelineRepository } from "../src/repository.js";

async function main() {
  const apply = process.argv.includes("--apply");
  const root = process.env.WORK_ROOT!;
  const u = new URL(process.env.PRODUCT_DATABASE_URL!); u.pathname = "/crawl_control_plane_v2"; u.search = "";
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });

  const rows = (await pool.query<{ id: string; url: string; item_count: number; captured: number; text_pending: number; capture_failed: number }>(
    `select r.id, s.url, r.item_count,
       (select count(*) from pipeline_job j where j.run_id=r.id and j.stage='capture_catalog' and j.state='completed')::int captured,
       (select count(*) from pipeline_job j where j.run_id=r.id and j.stage='process_text' and j.state<>'completed')::int text_pending,
       (select count(*) from pipeline_job j where j.run_id=r.id and j.stage='capture_catalog' and j.state='failed')::int capture_failed
     from pipeline_run r join pipeline_source s on s.id=r.source_id
     where s.adapter='swanson' and r.status='active' order by r.item_count desc`)).rows;

  const lost = rows.filter((r) => (r.captured && r.text_pending && !fs.existsSync(`${root}/${r.id}/v2/capture`)) || r.capture_failed);
  const urls = [...new Set(lost.map((r) => r.url))];
  const items = lost.reduce((sum, r) => sum + (r.item_count ?? 0), 0);
  console.log(`需重排 run ${lost.length} 个，${urls.length} 个品牌，${items} 个产品`);
  for (const r of lost) console.log(`  ${String(r.item_count).padStart(5)}  ${r.capture_failed ? "[抓取失败]" : "[数据丢失]"}  ${decodeURIComponent(r.url.split("facet.brand=")[1] ?? r.url)}`);
  if (!apply || !lost.length) { await pool.end(); return; }

  await pool.query(`update pipeline_run set status='abandoned', updated_at=now() where id = any($1::uuid[])`, [lost.map((r) => r.id)]);
  await pool.query(`update pipeline_review set status='resolved', resolution=$2, resolved_at=now() where run_id = any($1::uuid[]) and status='open'`,
    [lost.map((r) => r.id), "抓取数据丢失，已重排新 run"]);
  const repository = new PipelineRepository(pool);
  let created = 0;
  for (const url of urls) created += (await repository.createRuns({ urls: [url], mode: "one_off", scheduleTimezone: "Asia/Shanghai" })).created.length;
  console.log(`\n已作废 ${lost.length} 个旧 run · 重新提交 ${created} 个`);
  await pool.end();
}
main().catch((error) => { console.error(error.message); process.exit(1); });
