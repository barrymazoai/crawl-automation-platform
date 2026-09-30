/**
 * 把永久失败的任务归入复核队列，等统一处理。
 *
 * 面板上的 failed 是累计值、不会自己清零，历史事故（重启打断、数据丢失、上游连锁）留下的死账
 * 会一直显示成"正在失败"，掩盖真正的新问题。这里把它们转成 needs_review 并登记复核记录，
 * reason_code 保留原始失败码前缀 legacy_failure:，方便后续按原因批量处置。
 *
 * 只改状态、只新增复核记录，不删任何数据，可回滚。
 *
 * 用法：npx tsx scripts/failed-to-review.ts            只统计
 *       npx tsx scripts/failed-to-review.ts --apply    执行
 */
import pg from "pg";

async function main() {
  const apply = process.argv.includes("--apply");
  const u = new URL(process.env.PRODUCT_DATABASE_URL!); u.pathname = "/crawl_control_plane_v2"; u.search = "";
  const pool = new pg.Pool({ connectionString: u.toString(), max: 2 });

  const preview = (await pool.query<{ stage: string; code: string; n: string }>(
    `select stage, coalesce(error_code,'unknown') code, count(*) n from pipeline_job where state='failed' group by 1,2 order by 3 desc`)).rows;
  const total = preview.reduce((sum, r) => sum + Number(r.n), 0);
  console.log(`失败任务 ${total} 个：`);
  for (const r of preview) console.log(`  ${String(r.n).padStart(4)}  ${r.stage} / ${r.code}`);
  if (!apply || !total) { await pool.end(); return; }

  const client = await pool.connect();
  try {
    await client.query("begin");
    // 已有未关闭复核的不重复登记
    const inserted = await client.query(
      `insert into pipeline_review(id, run_id, job_id, reason_code, reason_message, status)
       select gen_random_uuid(), j.run_id, j.id,
              'legacy_failure:' || coalesce(j.error_code,'unknown'),
              left(coalesce(j.error_message,'历史失败，待统一处理'), 500), 'open'
       from pipeline_job j
       where j.state='failed'
         and not exists (select 1 from pipeline_review v where v.job_id=j.id and v.status='open')`);
    const moved = await client.query(`update pipeline_job set state='needs_review', updated_at=now() where state='failed'`);
    // run 的未决复核计数按实际重算，避免与历史值对不上
    await client.query(
      `update pipeline_run r set open_review_count = (select count(*) from pipeline_review v where v.run_id=r.id and v.status='open'), updated_at=now()
       where exists (select 1 from pipeline_review v where v.run_id=r.id)`);
    await client.query("commit");
    console.log(`\n转入复核 ${moved.rowCount} 个任务，新增复核记录 ${inserted.rowCount} 条`);
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
  await pool.end();
}
main().catch((error) => { console.error(error.message); process.exit(1); });
