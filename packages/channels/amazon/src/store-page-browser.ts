import { z } from "zod";
import { inspectStoreDom, STORE_SELECTORS } from "./store-dom.js";
import { scrollStorePage, STORE_SCROLL_POLICY } from "./store-scroll.js";

export const StoreObservationSchema = z.object({
  url: z.url(),
  html: z.string(),
  capturedAt: z.iso.datetime(),
  status: z.number().nullable(),
  tileCount: z.number().int().nonnegative(),
  asins: z.array(z.string()),
  navigation: z.array(z.string()),
  ready: z.boolean(),
  blocked: z.boolean(),
  invalidTiles: z.boolean(),
  more: z.boolean(),
  loading: z.boolean(),
  bottom: z.boolean(),
});
export const StoreDrawSchema = z.object({
  snapshots: z.array(StoreObservationSchema).min(1),
  proof: z.object({
    rounds: z.number().int().nonnegative(),
    stableRounds: z.number().int().nonnegative(),
    noMore: z.boolean(),
    bottom: z.boolean(),
    ended: z.enum(["stable", "capped", "unverified"]),
  }),
});

/** A managed Ego round owns and closes one fresh page, including failure and cancellation. */
export interface StoreBrowserRound {
  round(body: string, params: object, signal: AbortSignal): Promise<unknown>;
}

// Page actions use Ego's SDK. Only the read-only DOM projection runs in page.evaluate.
export function storePageBody(): string {
  return `
await page.goto(params.url, { timeout: 45000, waitUntil: "domcontentloaded" });
await page.waitForSelector(params.selectors.navigation, { timeout: 30000, state: "attached" })
  .catch(() => null);
const scroll = ${scrollStorePage.toString()};
const driver = {
  snapshot: async () => {
    const state = await page.evaluate((selectors) => {
      const inspect = ${inspectStoreDom.toString()};
      const data = inspect(document, selectors);
      const scopes = [...document.querySelectorAll(selectors.grid)];
      document.querySelectorAll('[data-crawlv3-store-more]').forEach(el =>
        el.removeAttribute('data-crawlv3-store-more'));
      const html = document.documentElement.outerHTML;
      const controls = scopes.flatMap(root => [...(root.parentElement ?? root).querySelectorAll('button, a')]);
      const candidates = controls.filter(el => /^(load|show|see) more(?: products)?$/i.test(el.textContent.trim()) &&
        el.getClientRects().length);
      const more = candidates.find(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true');
      more?.setAttribute('data-crawlv3-store-more', '1');
      const loading = candidates.some(el => el.disabled || el.getAttribute('aria-disabled') === 'true') ||
        scopes.some(root => root.matches('[aria-busy="true"]') ||
          [...root.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(el => el.getClientRects().length));
      const navigation = performance.getEntriesByType('navigation')[0];
      return { ...data, more: !!more, loading, url: location.href,
        status: navigation?.responseStatus || null, capturedAt: new Date().toISOString(),
        bottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4,
        html };
    }, params.selectors);
    return state;
  },
  advance: async (more) => {
    if (more) await page.click('[data-crawlv3-store-more="1"]', { label: 'load more Store products' });
    await page.evaluate(() => window.scrollBy(0, Math.max(300, window.innerHeight * 0.8)));
    await page.waitForTimeout(1000);
  }
};
return scroll(driver, params.policy);`;
}

export class AmazonStorePages {
  constructor(private readonly browser: StoreBrowserRound) {}

  async read(url: string, signal: AbortSignal) {
    const params = { url, selectors: STORE_SELECTORS, policy: STORE_SCROLL_POLICY };
    return StoreDrawSchema.parse(await this.browser.round(storePageBody(), params, signal));
  }
}
