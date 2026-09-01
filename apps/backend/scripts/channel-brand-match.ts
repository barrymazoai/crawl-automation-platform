/**
 * 公司 ↔ 渠道品牌 一次性匹配。
 *
 * 背景：库里的公司名和它在渠道上的品牌名经常对不上（Enzymedica® / Enzymedica、
 * Alani Nutrition LLC / Alani Nu），直接拿公司名拼 URL 去抓，会大量 404。
 * 渠道自己有权威品牌目录（GNC /brands 一页列出 270+ 个），抓一次就能拿到全部
 * 正确 slug，比逐个品牌去猜或去问模型既准又省。
 *
 * 匹配用词元级比较，不用子串——子串会把 Altavida 匹配成 Avid 这类完全不同的品牌。
 *
 * 用法：
 *   tsx scripts/channel-brand-match.ts --channel gnc --catalog gnc-brands.json --out matches.json
 */
import fs from "node:fs/promises";
import pg from "pg";

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const channel = (arg("channel") ?? "gnc").toLowerCase();
const catalogFile = arg("catalog");
const outFile = arg("out");
if (!catalogFile) { console.error("必须提供 --catalog <渠道品牌目录 json>"); process.exit(1); }

/** 法律后缀与行业通用词：这些词不能作为区分品牌的依据。 */
const NOISE = new Set([
  "inc", "llc", "ltd", "limited", "corp", "corporation", "company", "co", "gmbh", "sa", "bv",
  "group", "holdings", "brands", "brand", "the", "and", "of", "usa", "us", "international",
]);
/** 行业词：单独出现时无区分力，但保留在词元里参与"完全相等"判断。 */
const WEAK = new Set(["nutrition", "nutritionals", "nutraceuticals", "supplements", "supplement", "labs", "lab", "laboratories", "health", "wellness", "vitamins", "life", "sciences"]);

function tokens(raw: string) {
  return raw.toLowerCase().replace(/[®™©]/g, " ").split(/[^a-z0-9]+/)
    .filter((t) => t && !NOISE.has(t));
}
/** 强词元 = 去掉行业通用词后剩下的，真正能区分品牌的部分。 */
const strong = (ts: string[]) => ts.filter((t) => !WEAK.has(t));
const key = (ts: string[]) => ts.join("");

const catalog: Record<string, string> = JSON.parse(await fs.readFile(catalogFile, "utf8"));
/** 某个强词元被目录里几个品牌共用——共用的词不能单独作为匹配依据。 */
const tokenOwners = new Map<string, number>();
const brands = Object.entries(catalog).map(([slug, label]) => {
  const t = tokens(label && label.length > 1 ? label : slug);
  const st = tokens(slug);
  return { slug, label, tokens: t, strong: strong(t), key: key(t), slugKey: key(st), slugStrong: strong(st) };
});
for (const b of brands) {
  for (const t of new Set([...b.strong, ...strong(b.slugStrong)])) tokenOwners.set(t, (tokenOwners.get(t) ?? 0) + 1);
}
const isDistinctive = (token: string) => (tokenOwners.get(token) ?? 0) === 1;
console.log(`渠道 ${channel}：目录 ${brands.length} 个品牌`);

const pool = new pg.Pool({ connectionString: process.env.PRODUCT_DATABASE_URL, max: 1 });
const companies = (await pool.query(
  "select id, name, canonical_name from company where is_nutrition order by name")).rows;
await pool.end();
console.log(`库中营养品公司 ${companies.length} 家\n`);

type Tier = "exact" | "strong" | "subset";
type Match = { companyId: string; company: string; slug: string; label: string; url: string; tier: Tier };
const matched: Match[] = [];
const matchedCompanyIds = new Set<string>();

for (const c of companies) {
  const names = [c.name, c.canonical_name].filter(Boolean) as string[];
  let best: { brand: typeof brands[number]; tier: Tier } | null = null;
  for (const raw of names) {
    const t = tokens(raw);
    if (!t.length) continue;
    const k = key(t), st = strong(t), sk = key(st);
    // 1) 全部词元完全一致（含行业词），最可靠
    let b = brands.find((x) => x.key === k || x.slugKey === k);
    if (b) { best = { brand: b, tier: "exact" }; break; }
    // 2) 强词元完全一致：忽略 Nutrition / Labs 这类通用词的有无
    if (sk) {
      b = brands.find((x) => key(x.strong) === sk || key(x.slugStrong) === sk);
      if (b) { best = { brand: b, tier: "strong" }; break; }
    }
    // 3) 强词元子集：一方的强词元全部出现在另一方里。
    //    用词元包含而不是字符串子串——后者会把 Altavida 匹配成 Avid。
    //    只共用一个词元时，该词必须在目录里唯一，否则 "Amazing Muscle" 会命中
    //    "Amazing Nutrition"（两者只共享被多个品牌共用的 amazing）。
    if (st.length) {
      b = brands.find((x) => {
        const xs = x.strong.length ? x.strong : x.slugStrong;
        if (!xs.length) return false;
        const setA = new Set(st), setB = new Set(xs);
        const subset = [...setA].every((v) => setB.has(v)) || [...setB].every((v) => setA.has(v));
        if (!subset || Math.abs(setA.size - setB.size) > 1) return false;
        const sharedTokens = [...setA].filter((v) => setB.has(v));
        return sharedTokens.length >= 2 || sharedTokens.some(isDistinctive);
      });
      if (b) { best = { brand: b, tier: "subset" }; break; }
    }
  }
  if (best) {
    matched.push({
      companyId: c.id, company: c.name, slug: best.brand.slug, label: best.brand.label,
      url: `https://www.${channel}.com/brands/${best.brand.slug}/`, tier: best.tier,
    });
    matchedCompanyIds.add(c.id);
  }
}

const claimed = new Set(matched.map((m) => m.slug));
const orphans = brands.filter((b) => !claimed.has(b.slug));

// 反向：给每个未认领的渠道品牌找最接近的库内公司，供人工判断
const reverse = orphans.map((b) => {
  const bs = new Set(b.strong.length ? b.strong : b.slugStrong);
  const candidates = companies.filter((c) => {
    const cs = new Set(strong(tokens(String(c.name))));
    if (!cs.size || !bs.size) return false;
    let shared = 0;
    for (const v of bs) if (cs.has(v)) shared += 1;
    return shared > 0 && shared >= Math.min(bs.size, cs.size);
  }).slice(0, 3).map((c) => c.name);
  return { slug: b.slug, label: b.label, candidates };
});

const byTier = matched.reduce<Record<string, number>>((a, m) => { a[m.tier] = (a[m.tier] ?? 0) + 1; return a; }, {});
console.log(`匹配上 ${matched.length} 家  ${JSON.stringify(byTier)}`);
console.log(`未匹配公司 ${companies.length - matchedCompanyIds.size} 家`);
console.log(`渠道有、无人认领的品牌 ${orphans.length} 个（其中 ${reverse.filter((r) => r.candidates.length).length} 个能找到疑似公司）\n`);
console.log("匹配样本（按可信度）:");
for (const tier of ["exact", "strong", "subset"] as Tier[]) {
  const rows = matched.filter((m) => m.tier === tier).slice(0, 4);
  for (const m of rows) console.log(`  [${tier.padEnd(6)}] ${m.company.slice(0, 32).padEnd(32)} → ${m.slug}`);
}
console.log("\n无人认领但有疑似公司的品牌:");
for (const r of reverse.filter((x) => x.candidates.length).slice(0, 8)) {
  console.log(`  ${r.slug.padEnd(24)} ${r.label.slice(0, 22).padEnd(22)} ← ${r.candidates.join(" / ")}`);
}

/**
 * 输出分三档，用途不同：
 * - confirmed（exact + strong）：可以直接拿去抓，词元完全对齐，误配风险极低
 * - needsReview（subset）：只共享部分词元，像 Ancient Bliss / Ancient Nutrition
 *   这种是两家不同公司，必须人工过一遍才能用
 * - orphans：渠道有、我们没匹配上的品牌，可能是我们库里缺公司，也可能是漏匹配
 */
const confirmed = matched.filter((m) => m.tier !== "subset");
const needsReview = matched.filter((m) => m.tier === "subset");
console.log(`\n可直接使用 ${confirmed.length} 家 · 待人工确认 ${needsReview.length} 家 · 渠道未认领 ${orphans.length} 个`);
if (outFile) {
  await fs.writeFile(outFile, `${JSON.stringify({
    channel, generatedAt: new Date().toISOString(),
    confirmed, needsReview, orphans: reverse,
  }, null, 2)}\n`);
  console.log(`已写出: ${outFile}`);
  const urlFile = outFile.replace(/\.json$/, "") + "-urls.txt";
  await fs.writeFile(urlFile, `${confirmed.map((m) => m.url).join("\n")}\n`);
  console.log(`可直接抓取的 URL 清单: ${urlFile}（${confirmed.length} 条）`);
}
