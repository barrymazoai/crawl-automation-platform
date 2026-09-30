/** 追一个 run 从抓取到汇总的全过程，找出商品在哪一步丢的。 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

async function main() {
  const u = new URL(process.env.PRODUCT_DATABASE_URL!); u.pathname = "/crawl_control_plane_v2"; u.search = "";
  const pool = new pg.Pool({ connectionString: u.toString(), max: 1 });
  const brand = process.argv[2] ?? "Culturelle";
  const run = (await pool.query(
    `select r.id, s.url, r.item_count from pipeline_run r join pipeline_source s on s.id=r.source_id
     where s.adapter='swanson' and s.url like '%' || $1 || '%' order by r.created_at desc limit 1`, [brand])).rows[0];
  if (!run) { console.log("找不到这个品牌的 run"); await pool.end(); return; }
  console.log(`${brand}  run=${String(run.id).slice(0, 8)}  run.item_count=${run.item_count}`);

  console.log("\n各阶段产出:");
  for (const job of (await pool.query(
    `select stage, state, payload->>'batchId' batch, output from pipeline_job
     where run_id=$1 order by created_at`, [run.id])).rows) {
    const bits = Object.entries(job.output ?? {}).filter(([k]) => /Count/.test(k)).map(([k, v]) => `${k}=${v}`);
    console.log(`  ${String(job.stage).padEnd(17)} ${String(job.state).padEnd(12)} ${job.batch ?? "-"}  ${bits.join(" ")}`);
  }

  const root = path.join(process.env.WORK_ROOT!, String(run.id), "v2");
  console.log(`\n磁盘产物 ${root}:`);
  for (const kind of ["capture", "text", "images", "join", "unify"]) {
    const dir = path.join(root, kind);
    let batches: string[] = [];
    try { batches = fs.readdirSync(dir); } catch { console.log(`  ${kind.padEnd(8)} （无目录）`); continue; }
    for (const batch of batches) {
      const files: string[] = [];
      const batchDir = path.join(dir, batch);
      try { files.push(...fs.readdirSync(batchDir)); } catch { /* 文件不是目录 */ }
      console.log(`  ${kind.padEnd(8)} ${batch}  ${files.join(", ").slice(0, 90)}`);
      for (const name of files.filter((f) => /\.json$/.test(f) && !f.startsWith("capture.ready"))) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(batchDir, name), "utf8"));
          const counts = ["results", "facts", "products", "items", "unified"].filter((k) => Array.isArray(data?.[k]))
            .map((k) => `${k}=${data[k].length}`);
          const semantic = Array.isArray(data?.semantic?.results) ? `semantic.results=${data.semantic.results.length}` : "";
          if (counts.length || semantic) console.log(`             ${name}: ${[...counts, semantic].filter(Boolean).join(" ")}`);
        } catch { /* 跳过 */ }
      }
    }
  }
  await pool.end();
}
main().catch((error) => { console.error(error.message); process.exit(1); });
