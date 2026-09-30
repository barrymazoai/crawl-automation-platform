import { isAppError } from "@crawl-automation/platform";
import { z } from "zod";
import { wholeFoodsErrors } from "./whole-foods-errors.js";
import {
  STORE_PREFERENCE,
  wholeFoodsStoreCookie,
  type WholeFoodsStore,
} from "./whole-foods-store.js";

/**
 * In the browser, on one task page (every task page already answers location requests as denied, see ego-script),
 * open a Whole Foods page and read the store its page data is priced for. When it is another store, write the store
 * cookie (the site's own store preference, see wholeFoodsStoreCookie) into this profile and check again. The store
 * stays in the profile, so this changes something once per profile, not per page.
 */
const SET_STORE_BODY = `
const { storeId, cookie, productUrl, timeoutMs, pattern } = params;
const notSet = () => Object.assign(new Error("store not set"), { code: "WHOLEFOODS.STORE_NOT_SET" });
const shown = async () => {
  await page.goto(productUrl, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
  await page.waitForSelector("main", { timeout: timeoutMs, state: "attached" });
  return page.evaluate((source) => new RegExp(source).exec(document.documentElement.outerHTML)?.[1] ?? null, pattern);
};
if ((await shown()) === storeId) return { shown: storeId, changed: false };
await page.evaluate((value) => {
  document.cookie = value + "; path=/; domain=.wholefoodsmarket.com; max-age=31536000; secure";
}, cookie);
const after = await shown();
if (after !== storeId) throw notSet();
return { shown: after, changed: true };`;

const OutcomeSchema = z.object({ shown: z.string(), changed: z.boolean() });

/** The browser as the store setup needs it: one round of its own on a task page. */
export interface StoreSetupBrowser {
  round(body: string, params: object, signal: AbortSignal): Promise<unknown>;
}

/**
 * Makes sure the browser profile shops the configured store before a run reads any page. `productUrl` is any Whole
 * Foods page (brand scans pass their search URL).
 */
export async function ensureWholeFoodsStore(
  browser: StoreSetupBrowser,
  target: { store: WholeFoodsStore; productUrl: string; timeoutMs: number },
  signal: AbortSignal,
): Promise<{ changed: boolean }> {
  const { store, productUrl, timeoutMs } = target;
  const params = {
    storeId: store.storeId,
    cookie: wholeFoodsStoreCookie(store),
    productUrl,
    timeoutMs,
    pattern: STORE_PREFERENCE.source,
  };
  try {
    const outcome = OutcomeSchema.parse(await browser.round(SET_STORE_BODY, params, signal));
    return { changed: outcome.changed };
  } catch (error) {
    throw storeNotSet(error) ?? error;
  }
}

/** The round's own "store not set" failure, by its code, as this channel's error. */
function storeNotSet(error: unknown) {
  const failure = isAppError(error)
    ? (error.details["failure"] as { code?: unknown } | undefined)
    : undefined;
  if (failure?.code !== "WHOLEFOODS.STORE_NOT_SET") {
    return null;
  }
  return wholeFoodsErrors.create("WHOLEFOODS.STORE_NOT_SET", { cause: error });
}
