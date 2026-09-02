/** 把因基础设施故障（如 Clash 出口丢失）永久失败的抓取任务放回队列：重置尝试次数、立即可领。用法：npx tsx scripts/requeue-failed-job.ts <runId> */
import pg from "pg";
const runId = process.argv[2]; if (!runId) throw new Error("需要 runId");
const u = new URL(process.env.PRODUCT_DATABASE_URL!); u.pathname = "/crawl_control_plane_v2"; u.search = "";
const cp = new pg.Pool({ connectionString: u.toString() });
const r = await cp.query(`update pipeline_job set state='queued', attempt=0, available_at=now(), error_code=null, error_message=null, leased_by=null, lease_token_hash=null, lease_expires_at=null, updated_at=now() where run_id=$1 and stage='capture_catalog' and state='failed' returning id`, [runId]);
await cp.query(`update pipeline_run set status='active', error_code=null, error_message=null, updated_at=now() where id=$1`, [runId]);
console.log(`已重排 ${r.rowCount} 个任务`);
await cp.end();
