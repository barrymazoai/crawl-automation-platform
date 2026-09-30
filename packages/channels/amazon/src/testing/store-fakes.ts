import { RetainedPublication, type ObjectStore } from "@crawl-automation/platform";
import { inspectStoreDom, STORE_SELECTORS } from "../store-dom.js";
import { amazonDocument } from "../dom.js";
import type { StoreDraw, StoreObservation } from "../store-scroll.js";

export const storeHome = "https://www.amazon.com/stores/page/00000000-0000-0000-0000-000000000001";
export const storeShop = "https://www.amazon.com/stores/page/00000000-0000-0000-0000-000000000002";
export const asinOne = "B000000001";
export const asinTwo = "B000000002";

/** Synthetic DOM used only for unit cases; never presented as captured website evidence. */
export function storeHtml(asins: string[] = [asinOne], links: string[] = [storeHome]) {
  const navigation = links.map((link) => `<a href="${link}">Store page</a>`).join("");
  const tiles = asins
    .map(
      (asin) =>
        `<li class="ProductGridItem__itemOuter__test" data-asin="${asin}">
      <a href="/dp/${asin}">Product ${asin}</a></li>`,
    )
    .join("");
  return `<html><body><nav class="Navigation__navBar__test">${navigation}</nav>
    <ul class="ProductGrid__grid__test">${tiles}</ul></body></html>`;
}

export function observation(overrides: Partial<StoreObservation> = {}): StoreObservation {
  const html = overrides.html ?? storeHtml();
  return {
    url: storeHome,
    html,
    capturedAt: "2026-09-30T00:00:00.000Z",
    status: 200,
    ...inspectStoreDom(amazonDocument(html), STORE_SELECTORS),
    more: false,
    loading: false,
    bottom: true,
    ...overrides,
  };
}

export function drawPage(overrides: Partial<StoreObservation> = {}): StoreDraw {
  return {
    snapshots: [observation(overrides)],
    proof: { rounds: 3, stableRounds: 3, noMore: true, bottom: true, ended: "stable" },
  };
}

export class StoreMemory implements ObjectStore {
  readonly data = new Map<string, Uint8Array>();
  async read(key: string) {
    return this.data.get(key) ?? null;
  }
  async create(key: string, bytes: Uint8Array) {
    if (this.data.has(key)) {
      return "exists" as const;
    }
    this.data.set(key, Buffer.from(bytes));
    return "created" as const;
  }
}

export function storePublication() {
  const local = new StoreMemory();
  const remote = new StoreMemory();
  return { local, remote, publication: new RetainedPublication(local, remote) };
}
