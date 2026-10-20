import { preparationDomScript } from "./page-preparation-dom.js";

/** This code runs inside the existing managed Ego round; every action rechecks TaskSpace ownership. */
const PREPARATION = `
if (ready) {
  const started = Date.now();
  const deadline = started + Math.min(8000, read.timeoutMs / 4);
  const expanded = [];
  let scrolls = 0;
  let stable = 0;
  let previous = "";
  await requireAgent();
  await page.evaluate(() => {
    const guard = { blocked: 0 };
    guard.navigate = event => { if (event.cancelable) { event.preventDefault(); guard.blocked++; } };
    guard.submit = event => { event.preventDefault(); event.stopImmediatePropagation(); guard.blocked++; };
    guard.click = event => event.preventDefault();
    guard.open = window.open;
    window.open = () => { guard.blocked++; return null; };
    window.navigation?.addEventListener("navigate", guard.navigate);
    document.addEventListener("submit", guard.submit, true);
    document.addEventListener("click", guard.click, true);
    window.__crawlProductPreparation = guard;
  });
  while (Date.now() < deadline && expanded.length < 40 && stable < 4) {
    await requireAgent();
    const state = await page.evaluate(input => {
      ${preparationDomScript()}
      const action = preparationAction(document, input, preparationPolicy);
      const guard = window.__crawlProductPreparation;
      if (action && !guard.blocked && window.navigation) {
        const node = document.querySelector(action.target);
        if (action.kind === "details") node.setAttribute("open", "");
        else node.click();
      }
      const main = document.querySelector(PRODUCT_CONTENT.main);
      const bottom = !main || main.getBoundingClientRect().bottom <= window.innerHeight;
      if (!action && !bottom && input.scrolls < 12 && !guard.blocked) {
        window.scrollBy(0, Math.max(300, window.innerHeight * 0.8));
      }
      const roots = contentNodes(document, input.url, preparationPolicy).roots;
      return { action, bottom, blocked: guard.blocked,
        scrolled: !action && !bottom && input.scrolls < 12,
        signature: roots.map(root => root.outerHTML).join(""), pending: pendingContent(document, input.url, preparationPolicy) };
    }, { url: read.url, attempted: expanded.map(action => action.target), scrolls });
    if (state.action) expanded.push(state.action);
    if (state.scrolled) scrolls++;
    const pending = Object.values(state.pending).some(value => value > 0);
    stable = !state.action && state.bottom && !pending && state.signature === previous ? stable + 1 : 0;
    previous = state.signature;
    if (state.blocked) break;
    await page.waitForTimeout(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  await requireAgent();
  // Owner 2026-10-20: the store's own product JSON (Shopify's same-origin \`<handle>.js\`) is fetched by the page
  // itself and embedded in the snapshot, so the archived page carries variants, original images and the type/tags
  // the platform reader needs. No request leaves the browser; a store without it simply reports why.
  let productJson = "skipped";
  if (/\\/products\\/[^/?#]+\\/?(?:[?#]|$)/.test(read.url)) {
    productJson = await page.evaluate(async () => {
      try {
        if (document.querySelector('script[data-crawl-source="shopify-product-js"]')) return "embedded";
        const path = location.pathname.replace(/\\/$/, "");
        const response = await fetch(path + ".js", { credentials: "same-origin", headers: { accept: "application/json" } });
        if (!response.ok) return "http-" + response.status;
        const text = await response.text();
        const data = JSON.parse(text);
        if (!data || typeof data !== "object" || data.id === undefined || !Array.isArray(data.variants)) return "not-product";
        const script = document.createElement("script");
        script.type = "application/json";
        script.setAttribute("data-crawl-source", "shopify-product-js");
        script.textContent = text.split("</").join("<\\\\/");
        document.body.appendChild(script);
        return "embedded";
      } catch (error) {
        return "failed";
      }
    }).catch(() => "failed");
  }
  await requireAgent();
  preparation = await page.evaluate(input => {
    ${preparationDomScript()}
    const guard = window.__crawlProductPreparation;
    const expanded = input.expanded.map(action => {
      const node = document.querySelector(action.target);
      const revealed = action.kind === "details" ? node?.hasAttribute("open") : node?.getAttribute("aria-expanded") === "true";
      return { ...action, revealed: Boolean(revealed) };
    });
    return { expanded, scrolls: input.scrolls, pending: pendingContent(document, input.url, preparationPolicy),
      blockedActions: guard.blocked, ended: input.stable >= 4 && !guard.blocked ? "stable" : "capped",
      elapsedMs: input.elapsedMs, productJson: input.productJson };
  }, { url: read.url, expanded, scrolls, stable, elapsedMs: Date.now() - started, productJson });
}`;

export function dtcPreparationScript(): string {
  return PREPARATION;
}
