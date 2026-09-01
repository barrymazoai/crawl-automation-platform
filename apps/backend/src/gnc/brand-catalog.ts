import { createPageHolder } from "../amazon/browser.js";
import { GncAccessChallengeError, isGncAccessChallenge } from "./capture.js";
import type { SalesChannelNavigationRotation } from "../sales-channel-egress/types.js";

/**
 * 从 GNC 的 /brands 目录页收全部品牌。
 *
 * 目录是懒加载的，靠滚到底触发；滚到链接数不再增长为止，再核对页面自报的总数，
 * 对不上就判定这次没抓全——宁可下轮重来，也不能拿半份目录去把公司误判成"渠道没有"。
 */
const CATALOG_SCRIPT = `(() => {
  const anchors = [...document.querySelectorAll('a[href*="/brands/"]')];
  const seen = new Map();
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    const match = /\\/brands\\/([^/?#]+)/.exec(href);
    if (!match) return;
    const slug = match[1];
    if (!slug || slug === 'all') continue;
    const label = (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' ');
    if (!seen.has(slug) || (label && !seen.get(slug))) seen.set(slug, label);
  }
  const bodyText = document.body ? document.body.innerText : '';
  const totalMatch = /([0-9]{2,4})\\s+(?:Brands|Results)/i.exec(bodyText);
  return {
    entries: [...seen.entries()].map(([slug, label]) => ({ slug, label: label || slug })),
    expectedCount: totalMatch ? Number(totalMatch[1]) : null,
    denied: /Access Denied|verify you are a human|px-captcha/i.test(bodyText),
    scrollHeight: document.body ? document.body.scrollHeight : 0,
  };
})()`;

export interface GncBrandCatalogResult {
  entries: { slug: string; label: string }[];
  expectedCount: number | null;
  /** 抓到的数量与页面自报总数一致（或页面没报总数）。false 表示这份目录不可信。 */
  complete: boolean;
  scrollRounds: number;
}

export interface GncBrandCatalogOptions {
  url: string;
  signal: AbortSignal;
  rotation?: SalesChannelNavigationRotation;
  maxScrollRounds?: number;
  scrollWaitMs?: number;
}

function sleep(ms: number, signal: AbortSignal) {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function captureGncBrandCatalog(options: GncBrandCatalogOptions): Promise<GncBrandCatalogResult> {
  const maxRounds = options.maxScrollRounds ?? 40;
  const waitMs = options.scrollWaitMs ?? 1200;
  const holder = createPageHolder();
  try {
    let page = await holder.run(async (browser) => {
      const status = await browser.navigate(options.url);
      const value = await browser.evaluate<GncBrandCatalogResult & { denied: boolean; scrollHeight: number }>(CATALOG_SCRIPT);
      return { status, value };
    });
    let attempts = 0;
    while (isGncAccessChallenge(page.status, page.value.denied)) {
      if (!options.rotation || attempts >= options.rotation.maxFailureRetries) {
        throw new GncAccessChallengeError(options.url, page.status);
      }
      await holder.close();
      attempts += 1;
      if (!await options.rotation.rotateAfterFailure("challenge")) throw new GncAccessChallengeError(options.url, page.status);
      page = await holder.run(async (browser) => {
        const status = await browser.navigate(options.url);
        const value = await browser.evaluate<GncBrandCatalogResult & { denied: boolean; scrollHeight: number }>(CATALOG_SCRIPT);
        return { status, value };
      });
    }
    if (page.status >= 400) throw new Error(`GNC 品牌目录页不可读 HTTP ${page.status}: ${options.url}`);

    // 懒加载：滚到底直到品牌数不再增长
    let entries = page.value.entries;
    let expectedCount = page.value.expectedCount;
    let rounds = 0;
    let stagnant = 0;
    while (rounds < maxRounds && stagnant < 3) {
      if (options.signal.aborted) break;
      const before = entries.length;
      await holder.run(async (browser) => { await browser.evaluate("window.scrollTo(0, document.body.scrollHeight)"); });
      await sleep(waitMs, options.signal);
      const value = await holder.run(async (browser) =>
        browser.evaluate<GncBrandCatalogResult & { denied: boolean }>(CATALOG_SCRIPT));
      entries = value.entries;
      expectedCount = value.expectedCount ?? expectedCount;
      rounds += 1;
      stagnant = entries.length > before ? 0 : stagnant + 1;
    }

    const complete = expectedCount == null || entries.length >= expectedCount;
    return { entries, expectedCount, complete, scrollRounds: rounds };
  } finally { await holder.close(); }
}
