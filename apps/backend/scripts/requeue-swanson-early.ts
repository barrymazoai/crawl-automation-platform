/**
 * 把修复前跑的 Swanson 品牌重新排队。
 *
 * 那批产物的成分表是空的——不是页面没有，是当时浏览器通道读错内容/CDP 超时，
 * 抓下来就是坏数据。修复后实测命中率 100%，所以这些必须重跑而不是留着。
 */
import pg from "pg";
import { PipelineRepository } from "../src/repository.js";

/** 修复部署的时间点；在这之前创建的 run 拿的都是坏数据。 */
const FIX_DEPLOYED_AT = process.argv[2] ?? "2026-09-01T22:13:00+08:00";

async function main() {
  const u = new URL(process.env.PRODUCT_DATABASE_URL!); u.pathname = "/crawl_control_plane_v2"; u.search = "";
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  const repository = new PipelineRepository(pool);

  const stale = (await pool.query<{ id: string; url: string; status: string }>(
    `select r.id, s.url, r.status from pipeline_run r join pipeline_source s on s.id=r.source_id
     where s.adapter='swanson' and r.created_at < $1::timestamptz
       and r.status in ('completed','failed','abandoned') or (s.adapter='swanson' and r.created_at < $1::timestamptz and r.open_review_count > 0)
     order by r.created_at`, [FIX_DEPLOYED_AT])).rows;

  const urls = [...new Set(stale.map((row) => row.url))];
  console.log(`修复前的 run ${stale.length} 个，涉及 ${urls.length} 个不同来源`);
  for (const url of urls) console.log(`  ${url}`);
  if (!urls.length) { await pool.end(); return; }

  // 旧 run 标记作废，避免它们的复核记录继续占着队列
  await pool.query(
    `update pipeline_run set status='abandoned', updated_at=now()
     where id = any($1::uuid[]) and status <> 'abandoned'`, [stale.map((row) => row.id)]);
  await pool.query(
    `update pipeline_review set status='resolved', resolution=$2, resolved_at=now()
     where run_id = any($1::uuid[]) and status='open'`,
    [stale.map((row) => row.id), "修复前抓的成分表为空，已重排新 run"]);

  let created = 0;
  for (const url of urls) {
    const result = await repository.createRuns({ urls: [url], mode: "one_off", scheduleTimezone: "Asia/Shanghai" });
    created += result.created.length;
  }
  console.log(`\n已作废旧 run ${stale.length} 个 · 重新提交 ${created} 个`);
  await pool.end();
}
main().catch((error) => { console.error(error.message); process.exit(1); });
