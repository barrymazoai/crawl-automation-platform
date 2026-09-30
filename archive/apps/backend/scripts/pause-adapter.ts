/**
 * 暂停 / 恢复某个渠道的整条队列，不动 worker、不删任何东西。
 * 原理：claim 只领 available_at<=now() 的任务，把它推到远未来就是暂停。
 *
 * 用法：npx tsx scripts/pause-adapter.ts swanson pause
 *       npx tsx scripts/pause-adapter.ts swanson resume
 */
import pg from "pg";

const PAUSED_UNTIL = "2099-01-01T00:00:00Z";

async function main() {
  const [adapter, action] = process.argv.slice(2);
  if (!adapter || !["pause", "resume"].includes(action ?? "")) throw new Error("用法: pause-adapter.ts <adapter> pause|resume");
  const u = new URL(process.env.PRODUCT_DATABASE_URL!); u.pathname = "/crawl_control_plane_v2"; u.search = "";
  const pool = new pg.Pool({ connectionString: u.toString(), max: 2 });
  const result = await pool.query(
    action === "pause"
      ? `update pipeline_job j set available_at=$2::timestamptz, updated_at=now()
         from pipeline_run r join pipeline_source s on s.id=r.source_id
         where r.id=j.run_id and s.adapter=$1 and j.state in ('queued','retry_wait') and r.status<>'abandoned' and j.available_at<$2::timestamptz`
      : `update pipeline_job j set available_at=now(), updated_at=now()
         from pipeline_run r join pipeline_source s on s.id=r.source_id
         where r.id=j.run_id and s.adapter=$1 and j.state in ('queued','retry_wait') and j.available_at>=$2::timestamptz`,
    [adapter, PAUSED_UNTIL]);
  const stages = (await pool.query(
    `select j.stage, count(*)::int n from pipeline_job j join pipeline_run r on r.id=j.run_id join pipeline_source s on s.id=r.source_id
     where s.adapter=$1 and j.state in ('queued','retry_wait') and r.status<>'abandoned' and j.available_at>=$2::timestamptz group by 1 order by 1`, [adapter, PAUSED_UNTIL])).rows;
  console.log(`${adapter} ${action === "pause" ? "已暂停" : "已恢复"} ${result.rowCount} 个任务；当前仍处于暂停的：${stages.map((r) => `${r.stage}=${r.n}`).join(" ") || "无"}`);
  await pool.end();
}
main().catch((error) => { console.error(error.message); process.exit(1); });
