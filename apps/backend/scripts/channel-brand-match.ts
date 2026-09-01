/**
 * 公司 ↔ 渠道品牌 一次性匹配。
 *
 * 背景：我们库里的公司名和它在销售渠道上的品牌名经常不一致（Enzymedica® vs Enzymedica、
 * The Honest Company vs honest 等），直接拿公司名拼 URL 去抓，命中率没有保障。
 *
 * 做法：渠道自己就有权威品牌目录（GNC 的 /brands 一页列出 270+ 个品牌）。
 * 抓一次目录拿到「slug + 显示名」，再和库里全部公司做规范化匹配——
 * 一次请求解决全部公司，不需要为每个品牌单独调模型或开浏览器。
 *
 * 用法：
 *   tsx scripts/channel-brand-match.ts --channel gnc --catalog gnc-brands.json
 *   tsx scripts/channel-brand-match.ts --channel gnc --catalog gnc-brands.json --out matches.json
 *
 * catalog 文件格式（由浏览器抓取渠道目录页产出）：{ "slug": "显示名", ... }
 */
import fs from "node:fs/promises";
import pg from "pg";

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const channel = (arg("channel") ?? "gnc").toLowerCase();
const catalogFile = arg("catalog");
const outFile = arg("out");
if (!catalogFile) { console.error("必须提供 --catalog <渠道品牌目录 json>"); process.exit(1); }

/** 去掉商标符号、法律后缀、标点，统一大小写——两边用同一套规则才可比。 */
function normalize(raw: string) {
  return raw
    .toLowerCase()
    .replace(/[®™©]/g, " ")
    .replace(/&/g, " and ")
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|gmbh|group|holdings|brands|labs?|laboratories|nutrition(?:als)?|supplements?|usa)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}
/** 保留分词形态的宽松键，用于包含式近似匹配。 */
function loose(raw: string) {
  return raw.toLowerCase().replace(/[®™©]/g, "").replace(/[^a-z0-9]+/g, "");
}

const catalog: Record<string, string> = JSON.parse(await fs.readFile(catalogFile, "utf8"));
const brands = Object.entries(catalog).map(([slug, label]) => ({
  slug, label,
  normSlug: normalize(slug), normLabel: normalize(label),
  looseSlug: loose(slug), looseLabel: loose(label),
}));
console.log(`渠道 ${channel}：目录含 ${brands.length} 个品牌`);

const pool = new pg.Pool({ connectionString: process.env.PRODUCT_DATABASE_URL, max: 1 });
const companies = (await pool.query(
  "select id, name, canonical_name, website, sales_channels from company where is_nutrition order by name")).rows;
await pool.end();
console.log(`库中营养品公司 ${companies.length} 家\n`);

type Match = { companyId: string; company: string; slug: string; label: string; url: string; how: string };
const matched: Match[] = [];
const unmatched: Array<{ companyId: string; company: string }> = [];

for (const c of companies) {
  const candidates = [c.name, c.canonical_name].filter(Boolean) as string[];
  let hit: { brand: typeof brands[number]; how: string } | null = null;
  for (const raw of candidates) {
    const n = normalize(raw), l = loose(raw);
    if (!n) continue;
    // 1) 规范化后完全相等（最可靠）
    let b = brands.find((x) => x.normSlug === n || x.normLabel === n);
    if (b) { hit = { brand: b, how: "exact" }; break; }
    // 2) 宽松键完全相等（保留了被规范化规则吃掉的词，如 "labs"）
    b = brands.find((x) => x.looseSlug === l || x.looseLabel === l);
    if (b) { hit = { brand: b, how: "loose" }; break; }
    // 3) 包含式：仅在长度足够时启用，避免 "one" 命中 "onnit" 这类误配
    if (n.length >= 6) {
      b = brands.find((x) => (x.normLabel && (x.normLabel.includes(n) || n.includes(x.normLabel)) && Math.abs(x.normLabel.length - n.length) <= 4));
      if (b) { hit = { brand: b, how: "contains" }; break; }
    }
  }
  if (hit) {
    matched.push({
      companyId: c.id, company: c.name, slug: hit.brand.slug, label: hit.brand.label,
      url: `https://www.${channel}.com/brands/${hit.brand.slug}/`, how: hit.how,
    });
  } else unmatched.push({ companyId: c.id, company: c.name });
}

const byHow = matched.reduce<Record<string, number>>((acc, m) => { acc[m.how] = (acc[m.how] ?? 0) + 1; return acc; }, {});
const claimedSlugs = new Set(matched.map((m) => m.slug));
const orphanBrands = brands.filter((b) => !claimedSlugs.has(b.slug));

console.log(`匹配上: ${matched.length} 家  ${JSON.stringify(byHow)}`);
console.log(`没匹配上: ${unmatched.length} 家`);
console.log(`渠道有、我们库里没有对应公司的品牌: ${orphanBrands.length} 个\n`);
console.log("匹配样本:");
for (const m of matched.slice(0, 10)) console.log(`  [${m.how.padEnd(8)}] ${m.company.slice(0,32).padEnd(32)} → ${m.slug}`);
console.log("\n渠道独有品牌样本（我们可能漏抓的）:");
for (const b of orphanBrands.slice(0, 10)) console.log(`  ${b.slug.padEnd(28)} ${b.label}`);

if (outFile) {
  await fs.writeFile(outFile, `${JSON.stringify({ channel, generatedAt: new Date().toISOString(), matched, unmatched, orphanBrands: orphanBrands.map((b) => ({ slug: b.slug, label: b.label })) }, null, 2)}\n`);
  console.log(`\n已写出: ${outFile}`);
}
