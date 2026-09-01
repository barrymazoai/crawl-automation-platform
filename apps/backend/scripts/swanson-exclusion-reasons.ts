/** 查最近被排除的商品，到底是缺成分表还是语义线另有判断。 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

async function main() {
  const u = new URL(process.env.PRODUCT_DATABASE_URL!); u.pathname = "/crawl_control_plane_v2"; u.search = "";
  const pool = new pg.Pool({ connectionString: u.toString(), max: 1 });

  console.log("=== 复核原因分布 ===");
  for (const row of (await pool.query(
    `select v.reason_code, count(*)::int n from pipeline_review v
     join pipeline_run r on r.id=v.run_id join pipeline_source s on s.id=r.source_id
     where s.adapter='swanson' and v.status='open' group by 1 order by 2 desc`)).rows) {
    console.log(`  ${String(row.reason_code).padEnd(36)} ${row.n}`);
  }

  console.log("\n=== 最近完成的 catalog_finalize（可用 / 排除）===");
  const finals = (await pool.query(
    `select r.id, s.url, j.output, j.completed_at from pipeline_job j
     join pipeline_run r on r.id=j.run_id join pipeline_source s on s.id=r.source_id
     where s.adapter='swanson' and j.stage='catalog_finalize' and j.state='completed'
     order by j.completed_at desc limit 8`)).rows;
  for (const row of finals) {
    const o = row.output ?? {};
    console.log(`  ${String(row.url).replace(/^.*facet\.brand=/, "").slice(0, 26).padEnd(26)} 可用 ${o.includedCount} 排除 ${o.excludedCount} facts ${o.factsCount}`);
  }

  console.log("\n=== 逐个商品：成分表有没有 vs 语义线判了什么 ===");
  const root = process.env.WORK_ROOT!;
  let shown = 0;
  for (const row of finals) {
    if (shown >= 10) break;
    const runDir = path.join(root, String(row.id));
    // 抓取产物里的成分表
    const facts = new Map<string, number | null>();
    for (const batch of safeList(path.join(runDir, "v2", "capture"))) {
      for (const file of safeList(path.join(runDir, "v2", "capture", batch, "products"))) {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(runDir, "v2", "capture", batch, "products", file), "utf8"));
          facts.set(p.externalId, p.factsText ? String(p.factsText).length : null);
        } catch { /* 跳过 */ }
      }
    }
    // 语义线的判定
    for (const file of walk(runDir).filter((f) => /semantic.*result\.json$/.test(f)).slice(0, 2)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        const arr = JSON.parse(raw.payload ?? "[]");
        for (const item of arr.slice(0, 4)) {
          if (shown >= 10) break;
          const len = facts.get(item.sku);
          console.log(`  ${String(item.sku).padEnd(12)} 成分表 ${len ? `${len} 字` : "无"}  判定 ${item.scope_decision} · ${item.scope_reason ?? "-"}`);
          shown += 1;
        }
      } catch { /* 跳过 */ }
    }
  }
  await pool.end();
}

function safeList(dir: string) { try { return fs.readdirSync(dir); } catch { return []; } }
function walk(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  return safeList(dir).flatMap((name) => {
    const full = path.join(dir, name);
    try { return fs.statSync(full).isDirectory() ? walk(full, depth + 1) : [full]; } catch { return []; }
  });
}
main().catch((error) => { console.error(error.message); process.exit(1); });
