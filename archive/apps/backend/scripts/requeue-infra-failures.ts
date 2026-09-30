/**
 * 把"基础设施打死、数据完好"的任务放回工作队列（清单里的 B 类与 C 类）。
 *
 * B 类：重启或跨境断连导致的 lease_expired / *_worker_error，试满 5 次进了复核队列。
 * C 类：upstream_failed——自身没问题，只因上游 B 类失败被连带标记。
 *
 * 两类一起放回：C 类重置后会被 depends_on 挡着，等 B 类跑完自动解开，不需要第二次操作。
 *
 * 明确排除：
 *   - abandoned run 的任务（A 类，抓取目录已不存在，永远不会成功）
 *   - 数据类判定（D 类 *_ingest_review / *_no_ingestable_products）
 *   - 站点侧问题（E 类 gnc_access_challenge / *_no_products 等）
 * 这三类要么已归档，要么需要人的决定，不在本脚本范围内。
 *
 * 只改状态、关闭对应的复核记录，不删任何数据。
 *
 * 用法：npx tsx scripts/requeue-infra-failures.ts            预演
 *       npx tsx scripts/requeue-infra-failures.ts --apply    执行
 */
import pg from "pg";

// 只认这些错误码。lease_expired 和 *_worker_error 是基础设施问题，upstream_failed 是它们的连带。
const INFRA = `(
  j.error_code = 'lease_expired'
  or j.error_code = 'upstream_failed'
  or j.error_code like '%\\_worker\\_error'
)`;

// 复核记录的 reason_code 也要是 legacy_failure:*，避免误伤同码但语义不同的条目。
const WHERE = `j.state in ('needs_review','failed')
  and r.status <> 'abandoned'
  and ${INFRA}
  and exists (
    select 1 from pipeline_review v
    where v.job_id = j.id and v.status = 'open' and v.reason_code like 'legacy_failure:%'
  )`;

async function main() {
  const apply = process.argv.includes("--apply");
  const url = new URL(process.env.PRODUCT_DATABASE_URL!);
  url.pathname = "/crawl_control_plane_v2";
  url.search = "";
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });

  const preview = await pool.query<{ stage: string; adapter: string; code: string; n: string; items: string }>(
    `select j.stage, coalesce(s.adapter,'?') adapter, coalesce(j.error_code,'?') code,
            count(*) n, coalesce(sum((j.payload->>'itemCount')::int),0) items
     from pipeline_job j
     join pipeline_run r on r.id = j.run_id
     left join pipeline_source s on s.id = r.source_id
     where ${WHERE}
     group by 1,2,3 order by 4 desc`,
  );
  const total = preview.rows.reduce((sum, row) => sum + Number(row.n), 0);
  console.log(`基础设施类失败任务 ${total} 个：`);
  for (const row of preview.rows) {
    console.log(`  ${String(row.n).padStart(4)}  ${row.adapter.padEnd(8)} ${row.stage.padEnd(17)} ${row.code}` +
      (Number(row.items) ? `   (~${row.items} 个产品)` : ""));
  }
  if (!apply || !total) {
    await pool.end();
    if (!apply) console.log("\n（预演，加 --apply 执行）");
    return;
  }

  // 先把要动的 id 固定下来，事务里只按 id 操作，避免 WHERE 在事务中被自身改动影响。
  const ids = (await pool.query<{ id: string }>(
    `select j.id from pipeline_job j join pipeline_run r on r.id = j.run_id where ${WHERE}`,
  )).rows.map((row) => row.id);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const closed = await client.query(
      `update pipeline_review set status = 'resolved', resolved_at = now(),
         resolution = '基础设施故障（重启/断连）导致，数据完好，已重新排队'
       where job_id = any($1::uuid[]) and status = 'open' and reason_code like 'legacy_failure:%'`,
      [ids],
    );
    const moved = await client.query(
      `update pipeline_job set state = 'queued', attempt = 0, error_code = null, error_message = null,
         leased_by = null, lease_token_hash = null, lease_expires_at = null, output = null,
         started_at = null, completed_at = null, available_at = now(), updated_at = now()
       where id = any($1::uuid[]) returning run_id`,
      [ids],
    );
    const runIds = [...new Set(moved.rows.map((row) => row.run_id))];
    // 复核计数按实际重算，run 状态从 needs_review 复位
    await client.query(
      `update pipeline_run r set
         open_review_count = (select count(*) from pipeline_review v where v.run_id = r.id and v.status = 'open'),
         status = case when r.status in ('needs_review','failed','retry_wait') then 'active' else r.status end,
         updated_at = now()
       where r.id = any($1::uuid[])`,
      [runIds],
    );
    await client.query("commit");
    console.log(`\n事务已提交：重新排队 ${moved.rowCount} 个任务，关闭复核 ${closed.rowCount} 条，涉及 ${runIds.length} 个 run`);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // 不信 rowCount：提交后独立查一遍库做实证（09-04 踩过——事务 aborted 时 COMMIT 会被当成 ROLLBACK，
  // 而脚本仍按回滚前的 rowCount 打印"成功"）。
  const after = await pool.query<{ state: string; n: string }>(
    `select state, count(*) n from pipeline_job where id = any($1::uuid[]) group by 1 order by 2 desc`,
    [ids],
  );
  console.log("复核（重新查库）：", after.rows.map((row) => `${row.state}=${row.n}`).join("  "));
  const stuck = after.rows.filter((row) => row.state !== "queued").reduce((sum, row) => sum + Number(row.n), 0);
  if (stuck) {
    console.error(`有 ${stuck} 个没有变成 queued，改动可能没落库`);
    process.exitCode = 1;
  }
  await pool.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
