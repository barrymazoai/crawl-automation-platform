/** 看一个 run 的各阶段状态与产出计数。 */
import pg from "pg";
async function main() {
  const u = new URL(process.env.PRODUCT_DATABASE_URL!); u.pathname = "/crawl_control_plane_v2"; u.search = "";
  const pool = new pg.Pool({ connectionString: u.toString(), max: 1 });
  const id = process.argv[2] ?? (await pool.query(
    `select r.id from pipeline_run r join pipeline_source s on s.id=r.source_id
     where s.adapter='swanson' order by r.created_at desc limit 1`)).rows[0]?.id;
  const run = (await pool.query("select status, item_count, open_review_count from pipeline_run where id=$1", [id])).rows[0];
  console.log(`${String(id).slice(0, 8)} · ${run.status} · 商品 ${run.item_count} · 复核 ${run.open_review_count}`);
  for (const job of (await pool.query(
    `select stage, state, output, round(extract(epoch from coalesce(completed_at,now())-started_at))::int secs
     from pipeline_job where run_id=$1 order by created_at`, [id])).rows) {
    const bits = Object.entries(job.output ?? {})
      .filter(([key]) => /Count|scope/.test(key)).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
    console.log(`  ${String(job.stage).padEnd(17)} ${String(job.state).padEnd(12)} ${job.secs ?? "-"}s  ${bits.join(" ")}`);
  }
  for (const review of (await pool.query("select reason_code, reason_message from pipeline_review where run_id=$1", [id])).rows)
    console.log(`复核: ${review.reason_code} — ${review.reason_message}`);
  await pool.end();
}
main().catch((error) => { console.error(error.message); process.exit(1); });
