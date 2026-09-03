/**
 * 把 abandoned run 遗留的、抓取目录已经不在的任务移出工作队列。
 *
 * 09-02 丢数据那次，42 个 Swanson 品牌的 run 被判 abandoned 并已全部重抓，
 * 但它们的 process_text/product_join 任务还留在 retry_wait：available_at 早就到期，
 * worker 一遍遍领走、ENOENT 立刻失败、再放回去。既占领取周期，又让面板上的待办数
 * 虚高三倍（818 里有 532 是这种空转）。
 *
 * 这些任务不可能再成功——证据目录没了，对应品牌的新 run 已经跑过。按用户定的规矩
 * 归入 needs_review 统一处置，reason_code 单独一类，方便以后整批关闭。
 *
 * 只改状态、只新增复核记录，不删任何数据，可回滚。
 *
 * 用法：npx tsx scripts/abandoned-jobs-to-review.ts            只统计
 *       npx tsx scripts/abandoned-jobs-to-review.ts --apply    执行
 */
import pg from "pg";

const REASON = "abandoned_run:capture_missing";

async function main() {
  const apply = process.argv.includes("--apply");
  const url = new URL(process.env.PRODUCT_DATABASE_URL!);
  url.pathname = "/crawl_control_plane_v2";
  url.search = "";
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });

  // 只认三个条件同时成立的：run 已 abandoned、任务卡在 retry_wait、错误是目录不存在。
  const where = `j.state = 'retry_wait'
      and coalesce(j.error_message,'') like '%ENOENT%'
      and r.status = 'abandoned'`;

  const preview = await pool.query<{ stage: string; adapter: string; n: string; runs: string }>(
    `select j.stage, s.adapter, count(*) n, count(distinct j.run_id) runs
     from pipeline_job j
     join pipeline_run r on r.id = j.run_id
     join pipeline_source s on s.id = r.source_id
     where ${where}
     group by 1,2 order by 3 desc`,
  );
  const total = preview.rows.reduce((sum, row) => sum + Number(row.n), 0);
  console.log(`abandoned run 的空转任务 ${total} 个：`);
  for (const row of preview.rows) {
    console.log(`  ${String(row.n).padStart(4)}  ${row.stage} / ${row.adapter}（涉及 ${row.runs} 个 run）`);
  }

  // 这些品牌是不是真的都重抓过了——没重抓的绝不能就这么放走
  const orphan = await pool.query<{ url: string }>(
    `select distinct s.url from pipeline_job j
     join pipeline_run r on r.id = j.run_id
     join pipeline_source s on s.id = r.source_id
     where ${where}
       and not exists (
         select 1 from pipeline_run r2
         where r2.source_id = r.source_id and r2.status <> 'abandoned')`,
  );
  if (orphan.rowCount) {
    console.log(`\n⚠️  下面 ${orphan.rowCount} 个来源没有任何新 run，说明这个品牌的数据是真的没了，需要重新下发抓取：`);
    for (const row of orphan.rows) console.log(`     ${decodeURIComponent(row.url)}`);
    console.log("   （本脚本仍会把它们移出队列，但请另行补抓）");
  } else {
    console.log("\n涉及的品牌均已有新的 run 重抓过，移出队列不会丢任何品牌。");
  }

  if (!apply || !total) {
    await pool.end();
    if (!apply) console.log("\n（这是预演，加 --apply 才会执行）");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query(
      `insert into pipeline_review(id, run_id, job_id, reason_code, reason_message, status)
       select gen_random_uuid(), j.run_id, j.id, $1,
              'run 已 abandoned 且抓取目录已不存在，对应品牌已重抓，此任务不可能再成功', 'open'
       from pipeline_job j
       join pipeline_run r on r.id = j.run_id
       where ${where}
         and not exists (select 1 from pipeline_review v where v.job_id = j.id and v.status = 'open')`,
      [REASON],
    );
    const moved = await client.query(
      `update pipeline_job j set state = 'needs_review', updated_at = now()
       from pipeline_run r
       where r.id = j.run_id and ${where}`,
    );
    await client.query(
      `update pipeline_run r set open_review_count = (
         select count(*) from pipeline_review v where v.run_id = r.id and v.status = 'open'), updated_at = now()
       where exists (select 1 from pipeline_review v where v.run_id = r.id)`,
    );
    await client.query("commit");
    console.log(`\n移出队列 ${moved.rowCount} 个任务，新增复核记录 ${inserted.rowCount} 条`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
