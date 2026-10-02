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
      elapsedMs: input.elapsedMs };
  }, { url: read.url, expanded, scrolls, stable, elapsedMs: Date.now() - started });
}`;

export function dtcPreparationScript(): string {
  return PREPARATION;
}
