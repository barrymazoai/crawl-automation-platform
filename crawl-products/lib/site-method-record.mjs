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
