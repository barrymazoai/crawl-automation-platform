/**
 * 把"抓取产物已经不在磁盘上"的 run 归档，让它们停止空转。
 *
 * 09-02 的误删让一批 run 的 v2/capture/<批次>/products 目录消失。Swanson 那批当时被标成
 * abandoned 处理掉了，但同期的一些 run 仍是 active——它们的任务表面报 lease_expired
 * （09-03 重启造成），底下其实早就没有数据，重排队只会失败满 5 次再回到复核队列。
 *
 * 判定两条都要满足：(1) 抓取阶段确实完成过（排除还没开跑的 run）；(2) capture 目录下
 * 已经没有任何批次留着 products/。
 *
 * 范围收得很紧，只动**真的会空转**的任务：
 *   - 必须仍在工作状态（queued/running/retry_wait/failed/leased）；
 *   - 且依赖已全部完成，也就是现在就能被 worker 领走——只有这种才会被反复领取、失败、放回。
 * 两类明确不碰：
 *   - needs_review：等人决定的数据类判定（品牌映射、身份确认），目录同样是空的，
 *     但归档它们等于把复核队列冲掉（09-04 实测会误伤 457 个 ingest_staging）；
 *   - 被上游挡住的任务（典型是挂在复核项后面的 cleanup_run）：领取 SQL 本来就跳过，
 *     它们静静躺着不消耗任何东西，会随上游一起处置（09-04 实测 346 个）。
 *
 * 归档做三件事：这些任务转 needs_review 并登记 capture_artifacts_lost、
 * run 标成 abandoned（领取 SQL 会跳过，不再占领取周期）、复核计数重算。
 * 不删任何数据，已完成的任务与已入库的产品原样保留。
 *
 * 用法：npx tsx scripts/archive-lost-capture-runs.ts            预演
 *       npx tsx scripts/archive-lost-capture-runs.ts --apply    执行
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const REASON = "capture_artifacts_lost";
/** 这些状态不动：completed 已经好了；needs_review 是等人决定的，不归本脚本管。 */
const LEAVE_ALONE = ["completed", "needs_review"];

/** run 的抓取产物是否还在：任意一个批次目录下有 products/ 就算还在。 */
function hasCaptureArtifacts(workRoot: string, runId: string) {
  const captureDir = path.join(workRoot, runId, "v2", "capture");
  try {
    return fs.readdirSync(captureDir).some((batch) => {
      const products = path.join(captureDir, batch, "products");
      try { return fs.statSync(products).isDirectory() && fs.readdirSync(products).length > 0; } catch { return false; }
    });
  } catch {
    return false;
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const workRoot = process.env.WORK_ROOT!;
  if (!workRoot) throw new Error("需要 WORK_ROOT");
  const url = new URL(process.env.PRODUCT_DATABASE_URL!);
  url.pathname = "/crawl_control_plane_v2";
  url.search = "";
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });

  // 候选：还没归档、仍有未完成任务、且**抓取阶段确实已经完成过**的 run。
  // 最后这个条件很关键：目录不存在有两种可能——数据被删了，或者抓取压根还没跑。
  // 少了它会把排队等抓的 run 也归档掉（实测 gnc/mars-men 就是"已完成 0"的未开跑 run）。
  const candidates = await pool.query<{ id: string; url: string; adapter: string; status: string; pending: string; done: string }>(
    `select r.id, s.url, coalesce(s.adapter,'?') adapter, r.status,
            count(*) filter (where j.state <> all($1::text[]) and not exists (
              select 1 from pipeline_job dep where dep.id = any(j.depends_on) and dep.state <> 'completed')) pending,
            count(*) filter (where j.state = any($1::text[])) done
     from pipeline_run r
     join pipeline_source s on s.id = r.source_id
     join pipeline_job j on j.run_id = r.id
     where r.status <> 'abandoned'
       and exists (
         select 1 from pipeline_job c
         where c.run_id = r.id and c.stage in ('capture','capture_catalog') and c.state = 'completed')
       and exists (
         select 1 from pipeline_job d
         where d.run_id = r.id and d.stage in ('process_text','process_images') and d.state = 'completed')
     group by 1,2,3,4
     having count(*) filter (where j.state <> all($1::text[]) and not exists (
       select 1 from pipeline_job dep where dep.id = any(j.depends_on) and dep.state <> 'completed')) > 0`,
    [LEAVE_ALONE],
  );

  const lost = candidates.rows.filter((row) => !hasCaptureArtifacts(workRoot, row.id));
  console.log(`抓取已完成、队列里还有任务的 run：${candidates.rowCount} 个，其中抓取产物已丢失：${lost.length} 个\n`);
  if (!lost.length) { await pool.end(); return; }

  let pendingTotal = 0;
  for (const row of lost) {
    pendingTotal += Number(row.pending);
    console.log(`  ${row.adapter.padEnd(8)} 会空转 ${String(row.pending).padStart(3)} / 已完成 ${String(row.done).padStart(3)}  ${decodeURIComponent(row.url).replace("https://www.", "").slice(0, 62)}`);
  }
  console.log(`\n合计待归档任务 ${pendingTotal} 个（只含现在就能被领取的；needs_review 与被上游挡住的都不计入、也不会被改动）`);

  console.log("（归档只改任务状态，已完成的任务和已入库的产品原样保留）\n");

  if (!apply) { console.log("\n（预演，加 --apply 执行）"); await pool.end(); return; }

  const runIds = lost.map((row) => row.id);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const jobIds = (await client.query<{ id: string }>(
      `select j.id from pipeline_job j
       where j.run_id = any($1::uuid[]) and j.state <> all($2::text[])
         and not exists (select 1 from pipeline_job dep where dep.id = any(j.depends_on) and dep.state <> 'completed')`,
      [runIds, LEAVE_ALONE],
    )).rows.map((row) => row.id);
    const reviews = await client.query(
      `insert into pipeline_review(id, run_id, job_id, reason_code, reason_message, status)
       select gen_random_uuid(), j.run_id, j.id, $2,
              '抓取产物已从磁盘消失（09-02 误删），此任务不可能成功；要补齐需重新抓取该品牌', 'open'
       from pipeline_job j
       where j.id = any($1::uuid[])
         and not exists (select 1 from pipeline_review v where v.job_id = j.id and v.status = 'open')`,
      [jobIds, REASON],
    );
    const moved = await client.query(
      `update pipeline_job set state = 'needs_review', error_code = $2,
         error_message = '抓取产物已从磁盘消失，需重新抓取', updated_at = now()
       where id = any($1::uuid[])`,
      [jobIds, REASON],
    );
    await client.query(
      `update pipeline_run r set status = 'abandoned',
         open_review_count = (select count(*) from pipeline_review v where v.run_id = r.id and v.status = 'open'),
         updated_at = now()
       where r.id = any($1::uuid[])`,
      [runIds],
    );
    await client.query("commit");
    console.log(`\n事务已提交：归档 ${runIds.length} 个 run，转入复核 ${moved.rowCount} 个任务，新增复核记录 ${reviews.rowCount} 条`);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // 不信 rowCount，提交后重新查库
  const after = await pool.query<{ status: string; n: string }>(
    `select status, count(*) n from pipeline_run where id = any($1::uuid[]) group by 1`, [runIds]);
  console.log("复核（重新查库）run 状态：", after.rows.map((row) => `${row.status}=${row.n}`).join("  "));
  const left = await pool.query<{ n: string }>(
    `select count(*) n from pipeline_job j
     where j.run_id = any($1::uuid[]) and j.state not in ('completed','needs_review')
       and not exists (select 1 from pipeline_job dep where dep.id = any(j.depends_on) and dep.state <> 'completed')`,
    [runIds]);
  console.log(`这些 run 里仍能被领取的任务：${left.rows[0]!.n} 个（应为 0）`);
  if (Number(left.rows[0]!.n) > 0) process.exitCode = 1;
  await pool.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
