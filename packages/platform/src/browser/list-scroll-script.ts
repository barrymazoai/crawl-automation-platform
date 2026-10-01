/** Runs only in Ego's runtime, sharing read/page with READ_PAGE_BODY. */
export const LIST_SCROLL_BODY = `
const items = () =>
  page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)].map((item) => {
        const address = new URL(item.getAttribute("href") ?? "", location.href);
        address.search = "";
        return { href: address.href, html: item.outerHTML };
      }),
    read.scroll.itemSelector,
  );
const markMore = () =>
  page.evaluate((controls) => {
    document
      .querySelectorAll("[data-crawlv3-more]")
      .forEach((item) => item.removeAttribute("data-crawlv3-more"));
    const wanted = controls.texts.map((text) => text.toLowerCase());
    const button = [...document.querySelectorAll(controls.selector ?? "button, a[role=button]")].find(
      (element) =>
        element.offsetParent !== null &&
        (!controls.selector || (!element.disabled && element.getAttribute("aria-disabled") !== "true")) &&
        wanted.includes((controls.selector ? element.getAttribute("aria-label") || element.textContent : element.textContent).trim().toLowerCase()),
    );
    if (button) button.setAttribute("data-crawlv3-more", "1");
    return Boolean(button);
  }, { texts: read.scroll.moreTexts, selector: read.scroll.moreSelector });
const seen = new Map();
let finalCount = 0;
let itemCount = 0;
let missingCount = 0;
let shown = [];
// A growing list may re-rank a few items away (2026-10-01, Whole Foods: 30 -> 58 with 3 of the first 30 gone);
// every item seen is kept. The list is broken only when it shrinks or most of what was shown is replaced.
const observe = async () => {
  const current = await items();
  const identities = new Set(current.map((item) => item.href));
  const lost = shown.filter((href) => !identities.has(href)).length;
  const intact = current.length >= itemCount && lost * 2 <= shown.length;
  itemCount = current.length;
  shown = [...identities];
  missingCount = [...seen.keys()].filter((href) => !identities.has(href)).length;
  current.forEach((item) => {
    if (!seen.has(item.href)) seen.set(item.href, item);
  });
  finalCount = identities.size;
  return intact;
};
const wheel = async (more) => {
  const position = await page.evaluate((selector) => {
    const item = [...document.querySelectorAll(selector)].find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight;
    });
    const rect = (item ?? document.querySelector("main") ?? document.body).getBoundingClientRect();
    const button = document.querySelector('[data-crawlv3-more="1"]')?.getBoundingClientRect();
    return {
      x: Math.max(1, Math.min(innerWidth - 1, rect.x + rect.width / 2)),
      y: Math.max(1, Math.min(innerHeight - 1, rect.y + rect.height / 2)),
      height: innerHeight,
      visible: button && button.top >= 0 && button.bottom <= innerHeight,
    };
  }, read.scroll.itemSelector);
  await page.mouse.move(position.x, position.y);
  if (!more || !position.visible) await page.mouse.wheel(0, position.height / 2);
  return !more || position.visible;
};
let rounds = 0;
let stable = 0;
let ended = read.scroll ? "capped" : "none";
if (read.scroll) await observe();
while (read.scroll && rounds < read.scroll.maxRounds) {
  rounds += 1;
  if (!(await observe())) {
    ended = "broken";
    break;
  }
  const before = seen.size;
  const more = await markMore();
  if (read.scroll.pressDelayMs && !(await wheel(more))) {
    await page.waitForTimeout(read.scroll.settleMs);
    if (!(await observe())) {
      ended = "broken";
      break;
    }
    continue;
  }
  if (more) {
    if (read.scroll.pressDelayMs) {
      const { min, max } = read.scroll.pressDelayMs;
      await page.waitForTimeout(min + Math.floor(Math.random() * (max - min + 1)));
      if (!(await observe())) {
        ended = "broken";
        break;
      }
    }
    await page.evaluate(() => {
      const button = document.querySelector('[data-crawlv3-more="1"]');
      button?.removeAttribute("data-crawlv3-more");
      button?.click();
    });
    await page
      .waitForFunction(
        (wait) => document.querySelectorAll(wait.selector).length > wait.before,
        { selector: read.scroll.itemSelector, before: itemCount },
        { timeout: read.scroll.settleMs * 6 },
      )
      .catch((error) => {
        // Ego's wait timeout is a plain Error ("page.waitForFunction timed out after …", checked 2026-10-01).
        if (!/timed out/i.test(String(error?.message ?? ""))) throw error;
      });
  } else if (!read.scroll.pressDelayMs) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  }
  await page.waitForTimeout(read.scroll.settleMs);
  if (!(await observe())) {
    ended = "broken";
    break;
  }
  stable = seen.size > before || more || (await markMore()) ? 0 : stable + 1;
  if (stable >= read.scroll.stableRounds) {
    ended = "stable";
    break;
  }
}
const scroll = {
  rounds,
  ended,
  ...(read.scroll ? { seenCount: seen.size, finalCount, missingCount } : {}),
  ...(ended === "broken" || missingCount > 0 ? { observedItems: [...seen.values()] } : {}),
};
`;
