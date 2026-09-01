/**
 * 名字之外的佐证：官网域名与公司简介。
 *
 * 光靠名字匹配是在猜——Alpha Flow 和 Flow Supplements、Nature's Bounty 和
 * Nature's Lab 名字都沾边，却是完全不同的公司。这里用两条与名字相互独立的证据
 * 来复核：公司自己的官网域名，以及公司简介/关键词里有没有出现这个品牌名。
 *
 * 实测（GNC，240 条已匹配）：名字完全对齐的 123 家里 122 家能拿到佐证；
 * 而名字只是沾边的那批里，65 家一条佐证都没有，抽查全是误配。
 */

export type Corroboration = "domain_exact" | "domain_partial" | "profile" | "none";

const normalize = (value: string) => value.toLowerCase().replace(/[®™©]/g, "").replace(/[^a-z0-9]/g, "");

/** 取域名的主体部分：www.alaninu.com → alaninu，含二级后缀的 co.uk 也能处理。 */
export function domainRoot(site: string | null | undefined): string | null {
  if (!site) return null;
  try {
    const host = new URL(site.startsWith("http") ? site : `https://${site}`).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    if (parts.length < 2) return null;
    const root = parts.length > 2 && parts.at(-2)!.length <= 3 ? parts.at(-3) : parts.at(-2);
    const value = root ? normalize(root) : "";
    return value.length >= 3 ? value : null;
  } catch { return null; }
}

/**
 * 判断域名与渠道品牌的吻合程度。
 *
 * 刻意不做"剥掉行业词再比较"——那正是名字匹配栽过的坑：basicvitamins 与
 * basicsupplements 剥完都只剩 basic，可它们是两家不同的公司。
 */
export function domainRelation(root: string | null, slug: string, label: string): "exact" | "partial" | "none" {
  if (!root) return "none";
  const s = normalize(slug);
  const l = normalize(label);
  if (root === s || (l.length >= 3 && root === l)) return "exact";
  // 一方完整包含另一方，且被包含的一方本身够长，才算部分吻合
  const partial = [s, l].some((value) => value.length >= 5 && (root.includes(value) || value.includes(root)));
  return partial ? "partial" : "none";
}

/** 品牌名是否出现在公司简介/关键词里——与域名相互独立的第二条证据。 */
export function profileMentions(profile: string | null | undefined, slug: string, label: string) {
  if (!profile) return false;
  const text = normalize(profile);
  return [normalize(label), normalize(slug)].some((value) => value.length >= 5 && text.includes(value));
}

export interface CompanyEvidence {
  website?: string | null;
  profile?: string | null;
}

export interface EvidenceResult {
  corroboration: Corroboration;
  domainRoot: string | null;
  domain: "exact" | "partial" | "none";
  profile: boolean;
}

export function assessEvidence(company: CompanyEvidence, slug: string, label: string): EvidenceResult {
  const root = domainRoot(company.website);
  const domain = domainRelation(root, slug, label);
  const profile = profileMentions(company.profile, slug, label);
  const corroboration: Corroboration =
    domain === "exact" ? "domain_exact"
    : domain === "partial" && profile ? "domain_exact"
    : domain === "partial" ? "domain_partial"
    : profile ? "profile"
    : "none";
  return { corroboration, domainRoot: root, domain, profile };
}

/** 佐证够不够硬到可以自动去抓（而不是排进人工队列）。 */
export const isCorroborated = (result: EvidenceResult) =>
  result.corroboration === "domain_exact" || result.corroboration === "profile";
