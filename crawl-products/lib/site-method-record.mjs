import { parseHTML } from "linkedom";

/** Minimum evidence a learned product method must produce before it can be reused. */
export function missingSiteMethodFields(record, productUrl, galleryUrls) {
  const missing = [];
  const url = record?.productUrl ?? record?.sourceUrl;
  if (typeof url !== "string" || !sameProduct(url, productUrl)) missing.push("productUrl");
  if (typeof record?.fields?.title !== "string" || !record.fields.title.trim()
    || record.fields.title.trim().length > 4000) {
    missing.push("title");
  }
  const images = galleryUrls ?? record?.gallery ?? record?.fields?.images;
  const hasImages = Array.isArray(images) && images.some(image =>
    typeof image === "string" ? !!image.trim() : typeof image?.url === "string" && !!image.url.trim());
  const hasFacts = [record?.fields?.supplement_facts, record?.fields?.facts_table]
    .some(value => typeof value === "string" && !!value.trim());
  if (!hasImages && !hasFacts) missing.push("gallery_or_facts");
  return missing;
}

/** IDs duplicated by the saved region but unique on the observed full page. */
export function repeatedSiteMethodIds(productHtml, pageHtml) {
  const region = idCounts(productHtml);
  const page = idCounts(pageHtml);
  return [...region].filter(([id, count]) => count > 1 && page.get(id) === 1)
    .map(([id]) => id);
}

/** Candidate IDs when a projection has no retained full page for comparison. */
export function repeatedSiteMethodRegionIds(productHtml) {
  return [...idCounts(productHtml)].filter(([, count]) => count > 1).map(([id]) => id);
}

/** Check the base region and every captured variant against its own retained page. */
export async function repeatedSiteMethodMaterialIds(materials, notes, record, readHtml) {
  const recordPage = typeof record?.pageHtml === "string"
    ? record.pageHtml : record?.pageHtml?.localPath;
  const scopes = [{ name: "base", productHtml: materials?.productHtml,
    pageHtml: materials?.initialPage ?? notes?.pageHtml ?? recordPage },
  ...(materials?.variants ?? []).filter(scope => scope?.productHtml).map(scope => ({
    name: `variant:${scope.variantId}`, productHtml: scope.productHtml, pageHtml: scope.pageHtml,
  }))];
  const gaps = [];
  for (const scope of scopes) {
    // Without the retained full page a repeated id may be the site's own (SVG masks, widgets): do not reject.
    if (typeof scope.productHtml !== "string" || typeof scope.pageHtml !== "string") continue;
    const productHtml = await readHtml(scope.productHtml);
    if (!repeatedSiteMethodRegionIds(productHtml).length) continue;
    const ids = repeatedSiteMethodIds(productHtml, await readHtml(scope.pageHtml));
    if (ids.length) gaps.push({ scope: scope.name, ids });
  }
  return gaps;
}

function idCounts(html) {
  const counts = new Map();
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll("[id]")) {
    const id = node.getAttribute("id");
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function sameProduct(actual, expected) {
  try {
    const left = new URL(actual);
    const right = new URL(expected);
    return left.origin === right.origin
      && left.pathname.replace(/\/$/, "") === right.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}
