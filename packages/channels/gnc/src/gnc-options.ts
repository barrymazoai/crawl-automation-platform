import {
  classifyFamily,
  type ParsedProduct,
  type ProductFamily,
} from "@crawl-automation/channels-core";
import type { GncProductEvidence } from "@crawl-automation/v3-contracts";
import { DomUtils, parseDocument } from "htmlparser2";
import { GNC_ORIGIN } from "./gnc-address.js";

type Root = ReturnType<typeof parseDocument>["children"];
type Element = Extract<ReturnType<typeof DomUtils.findOne>, object>;

/** One option of the product page's picker: the SKU page it links and the label it shows. */
export interface GncOption {
  sku: string;
  url: string;
  label: string;
}

/** The page's one option group (e.g. "size"), with every option mapped to its own SKU page. */
export interface GncOptionGroup {
  group: string;
  options: GncOption[];
}

const squash = (element: Element) => DomUtils.textContent(element).replace(/\s+/g, " ").trim();

/** The 6-digit SKU page an option links, on www.gnc.com; null for anything else. */
function skuPageOf(element: Element): { sku: string; url: string } | null {
  const raw = element.attribs["data-url"] ?? element.attribs["href"];
  const url = raw ? URL.parse(raw, GNC_ORIGIN) : null;
  const sku =
    url?.hostname === "www.gnc.com" ? url.pathname.match(/\/(\d{6})\.html$/)?.[1] : undefined;
  return url && sku ? { sku, url: `${GNC_ORIGIN}${url.pathname}` } : null;
}

/** An option element: a link or button naming a 6-digit SKU page, with a readable label. */
function option(element: Element): GncOption | null {
  const page = skuPageOf(element);
  const label = (
    element.attribs["title"] ??
    element.attribs["data-attr-value"] ??
    squash(element)
  ).trim();
  return page && label ? { ...page, label: label.slice(0, 1000) } : null;
}

/**
 * The option picker as the page states it: exactly one `[data-attribute-id]` group whose every link names a SKU
 * page and a label. Anything less clear yields null: then no family is claimed and sibling reuse is not tried.
 */
export function readGncOptions(html: string): GncOptionGroup | null {
  const root: Root = parseDocument(html).children;
  const groups = DomUtils.findAll(
    (element) => element.attribs["data-attribute-id"] !== undefined,
    root,
  );
  if (groups.length !== 1) {
    return null;
  }
  const [block] = groups;
  if (!block) {
    return null;
  }
  const links = DomUtils.findAll(
    (element) => !!(element.attribs["data-url"] ?? element.attribs["href"]),
    [block],
  );
  const options = links.map(option);
  if (options.length < 2 || options.some((item) => item === null)) {
    return null;
  }
  const mapped = options.filter((item): item is GncOption => item !== null);
  const group = block.attribs["data-attribute-id"] ?? "";
  return group ? { group, options: mapped } : null;
}

/** The rendered GNC page: the parser's evidence and the page's option picker. */
export interface GncRendered {
  product: GncProductEvidence;
  options: GncOptionGroup | null;
}

/**
 * The product's family as its option picker shows it (F's `productFamily` hook): the current SKU must be exactly one
 * of the options; the others are the members, with their own labels. No member is ever guessed.
 */
export function gncProductFamily(parsed: ParsedProduct<GncRendered>): ProductFamily | null {
  const picker = parsed.rendered.options;
  if (!picker) {
    return null;
  }
  const sku = parsed.identity.listingId;
  const selected = picker.options.filter((item) => item.sku === sku);
  const others = picker.options.filter((item) => item.sku !== sku);
  const [current] = selected;
  if (selected.length !== 1 || !current || others.length === 0) {
    return null;
  }
  return {
    differsBy: classifyFamily(
      picker.group,
      picker.options.map((item) => item.label),
    ),
    group: picker.group,
    selectedLabel: current.label,
    members: others.map((item) => ({
      listingId: item.sku,
      variantId: null,
      url: item.url,
      label: item.label,
    })),
  };
}
