import { isAppError } from "@crawl-automation/platform";
import { z } from "zod";
import { WHOLE_FOODS_ORIGIN } from "./whole-foods-address.js";
import { wholeFoodsErrors } from "./whole-foods-errors.js";
import type { WholeFoodsStore } from "./whole-foods-store.js";

/**
 * In the browser, on one task page: deny the site's location prompt for this profile (it otherwise blocks the page),
 * open the brand search, and when it is priced for another store, pick the configured store through the site's own
 * store picker, then check again. The store is kept in the profile, so this runs once per run, not per page.
 */
const SET_STORE_BODY = `
const { store, productUrl, origin, timeoutMs } = params;
const notSet = () => Object.assign(new Error("store not set"), { code: "WHOLEFOODS.STORE_NOT_SET" });
await task.cdp("Browser.setPermission", { origin, permission: { name: "geolocation" }, setting: "denied" });
const open = async () => {
  await page.goto(productUrl, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
  await page.waitForSelector("main", { timeout: timeoutMs, state: "attached" });
};
const shown = () => page.evaluate(() => (/Pickup (?:at|from)\\s*\\n?\\s*([^\\n]+)/.exec(document.body.innerText) || [])[1]?.trim() ?? null);
const mark = (find) => page.evaluate(find.code, find.argument);
await open();
if ((await shown()) === store.label) return { shown: store.label, changed: false };
const change = await mark({ argument: null, code: () => {
  const control = [...document.querySelectorAll("button, a")].find((e) => e.textContent.trim() === "Change Store");
  control?.setAttribute("data-crawlv3-store", "change");
  return Boolean(control);
} });
if (!change) throw notSet();
await page.click('[data-crawlv3-store="change"]', { label: "open change store" });
await page.fill('input[name="postalCode"]', store.postalCode);
await page.press('input[name="postalCode"]', "Enter");
await page.waitForFunction((label) => document.body.innerText.includes("Whole Foods Market - " + label), store.label, { timeout: timeoutMs });
const pick = await mark({ argument: store.label, code: (label) => {
  const named = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent.trim() === "Whole Foods Market - " + label);
  for (let card = named[0]?.parentElement, depth = 0; card && depth < 8; card = card.parentElement, depth += 1) {
    const button = [...card.querySelectorAll("button")].find((e) => e.textContent.trim() === "Shop Store");
    if (button) { button.setAttribute("data-crawlv3-store", "shop"); return true; }
  }
  return false;
} });
if (!pick) throw notSet();
await page.click('[data-crawlv3-store="shop"]', { label: "shop this store" });
await page.waitForTimeout(3000);
await open();
const after = await shown();
if (after !== store.label) throw notSet();
return { shown: after, changed: true };`;

const OutcomeSchema = z.object({ shown: z.string(), changed: z.boolean() });

/** The browser as the store setup needs it: one round of its own on a task page. */
export interface StoreSetupBrowser {
  round(body: string, params: object, signal: AbortSignal): Promise<unknown>;
}

/**
 * Makes sure the browser profile shops the configured store before a run reads any page. `productUrl` is any Whole
 * Foods page (brand scans pass their search URL; the store picker is reached from it).
 */
export async function ensureWholeFoodsStore(
  browser: StoreSetupBrowser,
  target: { store: WholeFoodsStore; productUrl: string; timeoutMs: number },
  signal: AbortSignal,
): Promise<{ changed: boolean }> {
  const params = { ...target, origin: WHOLE_FOODS_ORIGIN };
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
