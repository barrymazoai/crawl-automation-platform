/** 提交任意一个 URL 跑正式流程。单个商品页也能跑——目录发现会把它当一条目录处理。 */
import pg from "pg";
import { PipelineRepository } from "../src/repository.js";
async function main() {
  const u = new URL(process.env.PRODUCT_DATABASE_URL!); u.pathname = "/crawl_control_plane_v2"; u.search = "";
  const pool = new pg.Pool({ connectionString: u.toString(), max: 2 });
  const result = await new PipelineRepository(pool).createRuns({
    urls: process.argv.slice(2), mode: "one_off", scheduleTimezone: "Asia/Shanghai",
  });
  for (const run of result.created) console.log(`runId=${run.id}`);
  for (const rejected of result.rejected) console.log(`拒绝: ${rejected.url} — ${rejected.reason}`);
  await pool.end();
}
main().catch((error) => { console.error(error.message); process.exit(1); });
