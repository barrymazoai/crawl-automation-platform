/**
 * 解析渠道品牌自己的官网。
 *
 * 名字匹配只能给出候选，真正能定案的是"这个品牌的官网"和"这家公司的官网"是不是
 * 同一个域名——域名对域名，没有模糊空间。GNC 自己不给这个信息（品牌页的外链只有
 * GNC 页脚，JSON-LD 的 brand 只有 name），所以按品牌 slug 与名字去猜域名，
 * 跟随跳转看最终落在哪里。
 *
 * 这件事按品牌算而不按公司算：目录 272 个品牌，公司 4092 家，查一次缓存下来
 * 所有公司都白用。请求也全部打在品牌自己的站点上，不占渠道的风控额度。
 */

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

const compact = (value: string) => value.toLowerCase().replace(/[®™©]/g, "").replace(/[^a-z0-9]/g, "");

/** 取域名主体：www.alaninu.com → alaninu.com；忽略 www。 */
export function hostOf(site: string | null | undefined): string | null {
  if (!site) return null;
  try {
    const host = new URL(site.startsWith("http") ? site : `https://${site}`).hostname.replace(/^www\./, "").toLowerCase();
    return host.includes(".") ? host : null;
  } catch { return null; }
}

/**
 * 由品牌 slug 与展示名推出候选域名。
 *
 * 两种写法都要试：alani-nu 既可能是 alaninu.com 也可能是 alani-nu.com；
 * 展示名去掉商标符号后往往才是真正的域名（KAGED® → kaged.com）。
 */
export function guessBrandHosts(slug: string, label: string): string[] {
  const stems = new Set<string>();
  stems.add(compact(slug));
  stems.add(slug.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  if (label) {
    stems.add(compact(label));
    stems.add(label.toLowerCase().replace(/[®™©]/g, "").trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""));
  }
  return [...stems].filter((stem) => stem.length >= 3 && !stem.startsWith("-") && !stem.endsWith("-")).map((stem) => `${stem}.com`);
}

export interface BrandSiteResult {
  /** 最终落地域名；解析不出来时为 null。 */
  host: string | null;
  /** 实际请求成功的那个候选域名。 */
  probed: string | null;
}

export interface BrandSiteFetch {
  (host: string): Promise<{ ok: boolean; finalUrl: string } | null>;
}

/** 默认实现：发一次 HTTPS 请求并跟随跳转。403 也算可达——很多站挡爬虫但域名是真的。 */
export const defaultFetch: BrandSiteFetch = async (host) => {
  try {
    const response = await fetch(`https://${host}`, {
      headers: { "user-agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok && response.status !== 403) return null;
    return { ok: true, finalUrl: response.url || `https://${host}` };
  } catch { return null; }
};

export async function resolveBrandSite(
  slug: string, label: string, fetcher: BrandSiteFetch = defaultFetch,
): Promise<BrandSiteResult> {
  for (const host of guessBrandHosts(slug, label)) {
    const result = await fetcher(host);
    if (!result?.ok) continue;
    const finalHost = hostOf(result.finalUrl);
    if (finalHost) return { host: finalHost, probed: host };
  }
  return { host: null, probed: null };
}

/**
 * 品牌官网与公司官网是否同一个站。
 *
 * 只认主域名相等，不做包含或剥词——那正是名字匹配栽过的坑。
 */
export function sameSite(brandHost: string | null, companySite: string | null | undefined) {
  const companyHost = hostOf(companySite);
  return Boolean(brandHost && companyHost && brandHost === companyHost);
}
