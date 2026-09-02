/**
 * 让一个 run 从某个处理阶段起重跑（规则/prompt 改了之后用），不重抓、不重 OCR。
 *
 * 做法：把该阶段及下游各阶段的 ready 标记**改名**为 .stale-<时间>（不删任何文件），
 * 再把这些阶段的 job 重置为 queued；worker 看不到 ready 标记就会重新计算。
 * 抓取（capture）和图片 OCR（images）不在重跑范围内，它们的产物原样复用。
 *
 * 用法：CONTROL_PLANE_DB=<控制面库 URL> WORK_ROOT=<运行目录> npx tsx scripts/rerun-stage.ts <runId> <text|join|unify|finalize>
 *   或在 mini 上 source 对应的 .env.worker(.cloud) 后运行（自动从 PRODUCT_DATABASE_URL 推导控制面库）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const ORDER = ["text", "join", "unify", "finalize"] as const;
type Stage = typeof ORDER[number];
const JOB_STAGES: Record<Stage, string[]> = {
  text: ["process_text"], join: ["product_join"], unify: ["product_unify"],
  finalize: ["catalog_finalize", "ingest_staging", "cleanup_run"],
};
const MARKER: Record<Stage, string> = { text: "text.ready.json", join: "join.ready.json", unify: "unify.ready.json", finalize: "finalize.ready.json" };

async function main() {
  const [runId, from] = process.argv.slice(2) as [string, Stage];
  if (!runId || !ORDER.includes(from)) throw new Error("用法: rerun-stage.ts <runId> <text|join|unify|finalize>");
  const workRoot = process.env.WORK_ROOT!;
  const dbUrl = process.env.CONTROL_PLANE_DB ?? (() => { const u = new URL(process.env.PRODUCT_DATABASE_URL!); u.pathname = "/crawl_control_plane_v2"; u.search = ""; return u.toString(); })();
  const stages = ORDER.slice(ORDER.indexOf(from));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(workRoot, runId, "v2");

  // 1. ready 标记改名（不删）
  let moved = 0;
  for (const stage of stages) {
    const dirs = stage === "finalize" ? [path.join(root, "finalize")]
      : await fs.readdir(path.join(root, stage)).then((names) => names.map((n) => path.join(root, stage, n))).catch(() => []);
    for (const dir of dirs) {
      const marker = path.join(dir, MARKER[stage]);
      if (await fs.stat(marker).then(() => true).catch(() => false)) { await fs.rename(marker, `${marker}.stale-${stamp}`); moved += 1; }
    }
  }

  // 2. job 重置为 queued（依赖关系原样保留，下游会等上游重新完成）
  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  const jobStages = stages.flatMap((s) => JOB_STAGES[s]);
  const reset = await pool.query(
    `update pipeline_job set state='queued', attempt=0, available_at=now(), error_code=null, error_message=null,
       leased_by=null, lease_token_hash=null, lease_expires_at=null, output=null, completed_at=null, updated_at=now()
     where run_id=$1 and stage = any($2::text[]) and state in ('completed','needs_review','failed','retry_wait','queued')`, [runId, jobStages]);
  await pool.query(`update pipeline_review set status='resolved', resolution=$2, resolved_at=now() where run_id=$1 and status='open'`, [runId, `从 ${from} 阶段重跑`]);
  await pool.query(`update pipeline_run set status='active', open_review_count=0, error_code=null, error_message=null, updated_at=now() where id=$1`, [runId]);
  await pool.end();
  console.log(`run ${runId}: 改名 ready 标记 ${moved} 个，重置 job ${reset.rowCount} 个（${jobStages.join(",")}）`);
}
main().catch((error) => { console.error(error.message); process.exit(1); });
