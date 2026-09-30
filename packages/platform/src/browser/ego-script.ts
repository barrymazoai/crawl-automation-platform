/**
 * Scripts for the Ego browser's own Node runtime (`ego-browser nodejs`). Ego exposes its browser only through this
 * SDK (TaskSpace and Page), so a round is a script; values reach it as JSON, never spliced as code. Every line the
 * crawler reads starts with the marker below; anything else the runtime prints is ignored.
 */
export const EGO_MARKER = "CRAWLV3_EGO:";

/** Runs in the page before its own scripts: location requests fail as denied, so no browser prompt appears. */
const DENY_LOCATION = `(() => {
  const denied = { code: 1, PERMISSION_DENIED: 1, message: "denied" };
  const fail = (_ok, error) => { if (typeof error === "function") setTimeout(() => error(denied), 0); return 0; };
  try {
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: fail, watchPosition: fail, clearWatch: () => {} } });
    const query = navigator.permissions?.query?.bind(navigator.permissions);
    if (query) navigator.permissions.query = (d) => d && d.name === "geolocation" ? Promise.resolve({ state: "denied", onchange: null }) : query(d);
  } catch {}
})();`;

const prelude = `const emit = (value) => console.log(${JSON.stringify(EGO_MARKER)} + JSON.stringify(value));`;

/**
 * One round on one task-owned page: open it, report its target at once (so an interrupted round still names what to
 * close), run the body, then always close the page and confirm the tab is gone. A space the user controls is left
 * alone. The body sees `task`, `page` and `params`, and returns a JSON value; a thrown `code` is reported as is.
 */
export function pageRoundScript(body: string, params: unknown): string {
  return `${prelude}
const params = ${JSON.stringify(params)};
const task = await taskSpace(params.taskSpaceId);
if (task.ownership === "user") {
  emit({ kind: "stop", reason: "user-control" });
} else {
  const page = await task.newPage();
  const targetId = page.targetId;
  emit({ kind: "opened", targetId });
  // A site's location prompt hands the task space to the user; this Ego version refuses Browser.setPermission, so
  // every task page answers location requests with "denied" before any site script runs (2026-09-30).
  await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: ${JSON.stringify(DENY_LOCATION)} });
  let value = null;
  let failure = null;
  let cleanupFailure = null;
  try {
    value = await (async () => {
${body}
    })();
  } catch (error) {
    failure = { name: String(error?.name ?? "Error"), code: typeof error?.code === "string" ? error.code : null, message: String(error?.message ?? error) };
  }
  let closed = false;
  try {
    await page.close();
    closed = !(await task.tabs()).some((tab) => tab.targetId === targetId);
  } catch (error) {
    cleanupFailure = { name: String(error?.name ?? "Error"), code: typeof error?.code === "string" ? error.code : null, message: String(error?.message ?? error) };
    closed = false;
  }
  emit({ kind: "result", targetId, closed, failure, cleanupFailure, value });
}`;
}

/** Closes exactly one earlier task page by its target, and confirms it is gone; never touches any other tab. */
export function closeTargetScript(params: { taskSpaceId: number; targetId: string }): string {
  return `${prelude}
const params = ${JSON.stringify(params)};
const task = await taskSpace(params.taskSpaceId);
if (task.ownership === "user") {
  emit({ kind: "stop", reason: "user-control" });
} else {
  const tabs = await task.tabs();
  const own = tabs.filter((tab) => tab.targetId === params.targetId);
  if (own.length === 1 && own[0].label) {
    await task.page(own[0].label).close();
  }
  const closed = !(await task.tabs()).some((tab) => tab.targetId === params.targetId);
  emit({ kind: "result", targetId: params.targetId, closed, failure: null, value: null });
}`;
}

/**
 * The body that reads one page: navigate, wait for the page's own ready element, optionally scroll or press its
 * "load more" button until no new items appear, then hand back the rendered HTML. A list ends as "stable" only when
 * repeated rounds add nothing and no "load more" button is left; stopping at the round limit is "capped".
 */
export const READ_PAGE_BODY = `
const read = params.read;
await page.goto(read.url, { timeout: read.timeoutMs, waitUntil: "domcontentloaded" });
let readinessFailure = null;
const ready = await page.waitForSelector(read.readySelector, { timeout: read.timeoutMs, state: "attached" })
  .then(() => true, (error) => {
    readinessFailure = { name: String(error?.name ?? "Error"), code: typeof error?.code === "string" ? error.code : null, message: String(error?.message ?? error) };
    return false;
  });
const count = () => page.evaluate((selector) => document.querySelectorAll(selector).length, read.scroll?.itemSelector ?? "a");
const markMore = () => page.evaluate((texts) => {
  const wanted = texts.map((text) => text.toLowerCase());
  const button = [...document.querySelectorAll("button, a[role=button]")].find((element) =>
    element.offsetParent !== null && wanted.includes(element.textContent.trim().toLowerCase()));
  if (button) button.setAttribute("data-crawlv3-more", "1");
  return Boolean(button);
}, read.scroll?.moreTexts ?? []);
let rounds = 0;
let stable = 0;
let ended = read.scroll ? "capped" : "none";
while (read.scroll && rounds < read.scroll.maxRounds) {
  rounds += 1;
  const before = await count();
  const more = await markMore();
  if (more) {
    // Pressed in the page: a pointer click scrolls a growing list and misses (2026-10-01, Whole Foods: 30 → 52 by DOM).
    await page.evaluate(() => {
      const button = document.querySelector('[data-crawlv3-more="1"]');
      button?.removeAttribute("data-crawlv3-more");
      button?.click();
    });
    // Wait for the list to grow: the next items can take longer than one settle, and the list can empty meanwhile.
    await page.waitForFunction(
      (wait) => document.querySelectorAll(wait.selector).length > wait.before,
      { selector: read.scroll.itemSelector ?? "a", before },
      { timeout: read.scroll.settleMs * 6 },
    ).catch(() => {});
  } else {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  }
  await page.waitForTimeout(read.scroll.settleMs);
  const after = await count();
  stable = after > before || more ? 0 : stable + 1;
  if (stable >= read.scroll.stableRounds) { ended = "stable"; break; }
}
const snapshot = await page.evaluate(() => {
  const navigation = performance.getEntriesByType("navigation")[0];
  return { url: location.href, status: navigation?.responseStatus || null, html: document.documentElement.outerHTML };
});
return { ...snapshot, ready, readinessFailure, scroll: { rounds, ended } };`;
