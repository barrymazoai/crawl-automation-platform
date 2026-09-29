import {
  brandScanErrors,
  type BrandScanReader,
  type ListedProduct,
  type ListingPage,
} from "@crawl-automation/channels-core";
import { DomUtils, parseDocument } from "htmlparser2";
import { GNC_ORIGIN, isSku } from "./gnc-address.js";
import { gncFamilyMembers } from "./gnc-family.js";

type Root = ReturnType<typeof parseDocument>["children"];
type Node = Root[number];
type Element = Extract<ReturnType<typeof DomUtils.findOne>, object>;

const PAGE_SIZE = 200;
const MAX_PAGES = 50;
const SORT = "new-arrivals";
const PAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const hasClass = (element: Element, name: string) =>
  (element.attribs["class"] ?? "").split(/\s+/).includes(name);
const squash = (node: Node | null) =>
  node ? DomUtils.textContent(node).replace(/\s+/g, " ").trim() : "";

function slugOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw, GNC_ORIGIN);
  } catch (error) {
    throw brandScanErrors.create("BRAND_SCAN.URL", { cause: error });
  }
  const slug = url.pathname.match(/^\/brands\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/)?.[1];
  const ownSite = url.origin === GNC_ORIGIN || url.origin === "https://gnc.com";
  if (!ownSite || url.username || url.password || !slug) {
    throw brandScanErrors.create("BRAND_SCAN.URL", { details: { url: raw } });
  }
  return slug;
}

function pageUrl(sourceUrl: string, page: number): string {
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES) {
    throw brandScanErrors.create("BRAND_SCAN.URL", { details: { page } });
  }
  const url = new URL(`${GNC_ORIGIN}/brands/${slugOf(sourceUrl)}/`);
  url.searchParams.set("srule", SORT);
  url.searchParams.set("start", String((page - 1) * PAGE_SIZE));
  url.searchParams.set("sz", String(PAGE_SIZE));
  return url.href;
}

/** A product tile: its ID (a 6-digit SKU or a family ID) and the link to its own page. Promotion tiles have none. */
function tileProduct(tile: Element): ListedProduct | null {
  const marked = DomUtils.findOne(
    (element) => element.attribs["data-itemid"] !== undefined,
    [tile],
  );
  if (!marked) {
    return null;
  }
  const id = marked.attribs["data-itemid"] ?? "";
  const links = DomUtils.findAll(
    (element) => element.name === "a" && !!element.attribs["href"],
    [tile],
  );
  const url = links
    .map((link) => URL.parse(link.attribs["href"] ?? "", GNC_ORIGIN))
    .find((href) => href?.hostname === "www.gnc.com" && href.pathname.endsWith(`/${id}.html`));
  if (!PAGE_ID.test(id) || !url || /demandware\.store/.test(url.pathname)) {
    throw brandScanErrors.create("BRAND_SCAN.TILE_IDENTITY", { details: { id } });
  }
  const kind = isSku(id) ? ("product" as const) : ("family" as const);
  return { url: `${GNC_ORIGIN}${url.pathname}`, listingId: id, variantId: null, title: null, kind };
}

/** The brand total the page states ("(585 Results)"); the per-page count attribute is only a fallback. */
function statedTotal(root: Root): number | null {
  const results = DomUtils.getElementById("results-products", root);
  const stated = squash(results).match(/(\d[\d,]*)\s+Results\b/)?.[1];
  if (stated) {
    return Number(stated.replaceAll(",", ""));
  }
  const count = DomUtils.findOne((element) => hasClass(element, "product-custom-count"), root);
  const value = Number(count?.attribs["data-actual-productcount"]);
  return Number.isFinite(value) && count ? value : null;
}

/** The next page: the load-more link must continue exactly after this page. */
function nextPage(root: Root, page: number, found: { cards: number; total: number | null }) {
  const more = DomUtils.findOne(
    (element) =>
      !!element.attribs["data-grid-url"] && /load-more/.test(element.attribs["class"] ?? ""),
    root,
  );
  const raw = more?.attribs["data-grid-url"];
  if (raw) {
    const start = Number(new URL(raw, GNC_ORIGIN).searchParams.get("start"));
    if (start !== page * PAGE_SIZE) {
      throw brandScanErrors.create("BRAND_SCAN.PAGINATION", { details: { start } });
    }
    return page + 1;
  }
  const beyond = found.cards > 0 && found.total !== null && found.total > page * PAGE_SIZE;
  return beyond ? page + 1 : null;
}

function parsePage(input: { body: string; url: string; page: number }): ListingPage {
  const root = parseDocument(input.body).children;
  const grid = DomUtils.findOne((element) => hasClass(element, "search-result-items"), root);
  if (
    !grid &&
    /verify (?:that )?you are (?:a )?human|px-captcha|captcha-container|Access Denied/i.test(
      input.body,
    )
  ) {
    throw brandScanErrors.create("BRAND_SCAN.ACCESS_CHALLENGE");
  }
  const tiles = grid
    ? DomUtils.findAll((element) => element.name === "li" && hasClass(element, "grid-tile"), [grid])
    : [];
  const products = tiles.map(tileProduct).filter((product) => product !== null);
  const listed = new Map<string, ListedProduct>();
  for (const product of products) {
    if (!listed.has(product.listingId)) {
      listed.set(product.listingId, product);
    }
  }
  const total = statedTotal(root);
  if (listed.size > 0 && total === null) {
    throw brandScanErrors.create("BRAND_SCAN.COUNT_MISSING");
  }
  // Every product tile counts towards the stated total, as in the 09-28 scan tool.
  const cards = products.length;
  return {
    products: [...listed.values()],
    cards,
    nextPage: nextPage(root, input.page, { cards, total }),
    statedTotal: total,
  };
}

/**
 * GNC brand scans: `/brands/<slug>/?srule=new-arrivals&start=N&sz=200` through ScraperAPI (checked 2026-09-28: plain
 * HTML, no challenge). The page states the brand total, so a scan is full only when it read exactly that many tiles.
 */
export const gncBrandScan: BrandScanReader = {
  sourceUrl: (url) => `${GNC_ORIGIN}/brands/${slugOf(url)}/`,
  pageUrl,
  answer: "html",
  maxPages: MAX_PAGES,
  maxBytes: 16 * 1024 * 1024,
  parsePage,
  complete: (pages) => {
    const last = pages.at(-1);
    const read = pages.reduce((sum, page) => sum + page.cards, 0);
    return (
      !!last && last.nextPage === null && last.statedTotal !== null && read === last.statedTotal
    );
  },
  familyMembers: gncFamilyMembers,
};
