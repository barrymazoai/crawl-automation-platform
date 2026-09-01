/** 列出某渠道最近失败的抓取任务及其来源 URL。 */
import pg from "pg";
async function main() {
  const u = new URL(process.env.PRODUCT_DATABASE_URL!); u.pathname = "/crawl_control_plane_v2"; u.search = "";
  const pool = new pg.Pool({ connectionString: u.toString(), max: 1 });
  const adapter = process.argv[2] ?? "swanson";
  const rows = (await pool.query(
    `select j.state, j.attempt, j.error_message, s.url
     from pipeline_job j join pipeline_run r on r.id=j.run_id join pipeline_source s on s.id=r.source_id
     where s.adapter=$1 and j.stage='capture_catalog' and j.error_message is not null
     order by j.updated_at desc limit 6`, [adapter])).rows;
  for (const row of rows) {
    console.log(`  ${row.state} 尝试${row.attempt}  ${row.url}`);
    console.log(`     ${String(row.error_message).slice(0, 100)}`);
  }
  if (!rows.length) console.log("  （没有失败记录）");
  await pool.end();
}
main().catch((error) => { console.error(error.message); process.exit(1); });
