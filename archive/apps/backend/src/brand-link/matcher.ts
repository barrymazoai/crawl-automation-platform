/**
 * 公司名 ↔ 渠道品牌名的词元级匹配。
 *
 * 为什么不用子串：子串会把 Altavida 匹配成 Avid、把 Amazing Muscle 匹配成
 * Amazing Nutrition，这些是完全不同的公司。词元比较 + 唯一性约束能挡住这两类误配。
 */

/** 法律后缀与行业通用词：这些词不能作为区分品牌的依据。 */
const NOISE = new Set([
  "inc", "llc", "ltd", "limited", "corp", "corporation", "company", "co", "gmbh", "sa", "bv",
  "group", "holdings", "brands", "brand", "the", "and", "of", "usa", "us", "international",
]);
/** 行业词：单独出现时无区分力，但保留在词元里参与"完全相等"判断。 */
const WEAK = new Set([
  "nutrition", "nutritionals", "nutraceuticals", "supplements", "supplement",
  "labs", "lab", "laboratories", "health", "wellness", "vitamins", "life", "sciences",
]);

export function tokens(raw: string) {
  return rawTokens(raw).filter((t) => !NOISE.has(t));
}
const rawTokens = (raw: string) => raw.toLowerCase().replace(/[®™©]/g, " ").split(/[^a-z0-9]+/).filter(Boolean);
/** 被当作无区分力而剥掉的词（法律后缀 + 行业通用词）。 */
const dropped = (raw: string) => new Set(rawTokens(raw).filter((t) => NOISE.has(t) || WEAK.has(t)));
/**
 * 两边剥掉的词是否兼容：一方剥掉的必须是另一方的子集。
 *
 * 剥词之后再判相等是不安全的——Nature's Brands 和 Nature's Lab 剥完都只剩 natures，
 * 可真正区分它们的恰恰就是被剥掉的 Brands / Lab。要求剥掉的词互为子集，
 * 就只放行"一方多带了几个通用词"这种情况（Enzymedica Labs vs Enzymedica）。
 */
function droppedCompatible(a: Set<string>, b: Set<string>) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  return [...small].every((t) => large.has(t));
}
/** 强词元 = 去掉行业通用词后剩下的、真正能区分品牌的部分。 */
export const strong = (list: readonly string[]) => list.filter((t) => !WEAK.has(t));
const key = (list: readonly string[]) => list.join("");

export interface CatalogEntry { slug: string; label: string }
/** exact/strong 可直接抓；subset 只共享部分词元，必须人工确认。 */
export type MatchTier = "exact" | "strong" | "subset";
export interface BrandMatch { slug: string; label: string; tier: MatchTier }

interface PreparedBrand extends CatalogEntry {
  key: string; strongKey: string; strong: string[];
  slugKey: string; slugStrong: string[];
  dropped: Set<string>;
}

/**
 * 把渠道目录预处理成可反复查询的匹配器。目录只有几百条，整份放内存，
 * 因此单次匹配是纯内存运算、不发任何网络请求——解析线可以随便跑。
 */
export class BrandCatalogMatcher {
  private brands: PreparedBrand[];
  /** 某个强词元被目录里几个品牌共用；共用的词不能单独作为匹配依据。 */
  private tokenOwners = new Map<string, number>();

  constructor(entries: readonly CatalogEntry[]) {
    this.brands = entries.map((entry) => {
      const labelTokens = tokens(entry.label && entry.label.length > 1 ? entry.label : entry.slug);
      const slugTokens = tokens(entry.slug);
      return {
        ...entry,
        key: key(labelTokens), strong: strong(labelTokens), strongKey: key(strong(labelTokens)),
        slugKey: key(slugTokens), slugStrong: strong(slugTokens),
        dropped: dropped(entry.label && entry.label.length > 1 ? entry.label : entry.slug),
      };
    });
    for (const brand of this.brands) {
      for (const token of new Set([...brand.strong, ...brand.slugStrong])) {
        this.tokenOwners.set(token, (this.tokenOwners.get(token) ?? 0) + 1);
      }
    }
  }

  get size() { return this.brands.length; }

  private isDistinctive(token: string) { return (this.tokenOwners.get(token) ?? 0) === 1; }

  /**
   * 传入公司的所有已知名称（name / canonical_name），返回最可信的一条匹配。
   *
   * 必须把所有名字都试完再挑最高档，不能一命中就返回：Alani Nutrition LLC 只能凑出
   * subset，而它的 canonical_name「Alani Nu」是 exact——先返回 subset 会平白把一条
   * 可直接抓的链接降级成待人工确认。
   */
  match(names: readonly string[]): BrandMatch | null {
    const rank: Record<MatchTier, number> = { exact: 3, strong: 2, subset: 1 };
    let best: BrandMatch | null = null;
    const consider = (hit: BrandMatch) => {
      if (!best || rank[hit.tier] > rank[best.tier]) best = hit;
      return best.tier === "exact";
    };
    for (const raw of names) {
      if (!raw) continue;
      const all = tokens(raw);
      if (!all.length) continue;
      const allKey = key(all);
      const strongTokens = strong(all);
      const strongKey = key(strongTokens);

      // 1) 全部词元完全一致（含行业词），最可靠
      let hit = this.brands.find((b) => b.key === allKey || b.slugKey === allKey);
      if (hit && consider({ slug: hit.slug, label: hit.label, tier: "exact" })) return best;

      // 2) 强词元完全一致：忽略 Nutrition / Labs 这类通用词的有无
      if (strongKey) {
        const rawDropped = dropped(raw);
        hit = this.brands.find((b) =>
          (b.strongKey === strongKey || key(b.slugStrong) === strongKey) && droppedCompatible(rawDropped, b.dropped));
        if (hit) { consider({ slug: hit.slug, label: hit.label, tier: "strong" }); continue; }
      }

      // 3) 强词元子集：一方的强词元全部出现在另一方里。只共用一个词元时，
      //    该词必须在目录里唯一，否则 Amazing Muscle 会命中 Amazing Nutrition。
      if (strongTokens.length) {
        const rawDropped = dropped(raw);
        hit = this.brands.find((b) => {
          const brandTokens = b.strong.length ? b.strong : b.slugStrong;
          if (!brandTokens.length) return false;
          // 同 strong 档：剥掉的词必须兼容，否则区分词被剥掉的那类误配会从这里溜进来
          if (!droppedCompatible(rawDropped, b.dropped)) return false;
          const left = new Set(strongTokens), right = new Set(brandTokens);
          const subset = [...left].every((v) => right.has(v)) || [...right].every((v) => left.has(v));
          if (!subset || Math.abs(left.size - right.size) > 1) return false;
          const shared = [...left].filter((v) => right.has(v));
          return shared.length >= 2 || shared.some((token) => this.isDistinctive(token));
        });
        if (hit) consider({ slug: hit.slug, label: hit.label, tier: "subset" });
      }
    }
    return best;
  }
}
