import { recordRecovery } from "@crawl-automation/platform";
import type { ListedProduct, ListingPageContent } from "@crawl-automation/channels-core";
import { DomUtils, parseDocument } from "htmlparser2";
import { GNC_ORIGIN, isSku } from "./gnc-address.js";

type Json = Record<string, unknown>;
type Root = ReturnType<typeof parseDocument>["children"];

const isRecord = (value: unknown): value is Json =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const types = (value: Json) => (Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]]);

/** A member link: a 6-digit SKU page on www.gnc.com, whatever the category path. */
function skuPage(raw: unknown): ListedProduct | null {
  const url = typeof raw === "string" ? URL.parse(raw, GNC_ORIGIN) : null;
  const id = url?.pathname.match(/\/(\d{6})\.html$/)?.[1];
  if (!url || url.hostname !== "www.gnc.com" || !id || !isSku(id)) {
    return null;
  }
  return {
    url: `${GNC_ORIGIN}${url.pathname}`,
    listingId: id,
    variantId: null,
    title: null,
    kind: "product",
  };
}

/** Members a JSON-LD `ProductGroup` lists (`hasVariant[].offers.url` or `.url`). */
function groupMembers(root: Root): ListedProduct[] {
  const scripts = DomUtils.findAll(
    (element) => element.name === "script" && element.attribs["type"] === "application/ld+json",
    root,
  );
  const groups = scripts.flatMap((script) => {
    try {
      const value: unknown = JSON.parse(DomUtils.textContent(script));
      return (Array.isArray(value) ? value : [value]).filter(
        (item): item is Json => isRecord(item) && types(item).includes("ProductGroup"),
      );
    } catch (error) {
      recordRecovery(error, { operation: "gnc-family" });
      // A broken JSON-LD block lists no members; the option links below are read regardless.
      return [];
    }
  });
  const variants = groups.flatMap((group) =>
    Array.isArray(group["hasVariant"]) ? group["hasVariant"].filter(isRecord) : [],
  );
  return variants
    .map((variant) =>
      skuPage(isRecord(variant["offers"]) ? variant["offers"]["url"] : variant["url"]),
    )
    .filter((member) => member !== null);
}

/** Members the option picker links (`.product-variations` or `[data-attribute-id]` blocks). */
function optionMembers(root: Root): ListedProduct[] {
  const blocks = DomUtils.findAll(
    (element) =>
      (element.attribs["class"] ?? "").split(/\s+/).includes("product-variations") ||
      element.attribs["data-attribute-id"] !== undefined,
    root,
  );
  const links = DomUtils.findAll(
    (element) => !!(element.attribs["data-url"] ?? element.attribs["href"]),
    blocks,
  );
  return links
    .map((link) => skuPage(link.attribs["data-url"] ?? link.attribs["href"]))
    .filter((member) => member !== null);
}

/**
 * The member SKUs of a GNC family page (a listing tile with a family ID such as `GNCTotalLeanLeanShake12Pack`): the
 * JSON-LD product group, and the option picker's own links. Nothing is guessed from file names or titles; a family
 * page that shows neither yields no members.
 */
export function gncFamilyMembers(page: ListingPageContent): ListedProduct[] {
  const root = parseDocument(page.html).children;
  const members = new Map<string, ListedProduct>();
  for (const member of [...groupMembers(root), ...optionMembers(root)]) {
    members.set(member.listingId, member);
  }
  return [...members.values()];
}
