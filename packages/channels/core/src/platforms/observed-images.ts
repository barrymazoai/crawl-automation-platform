/** Collapse only Shopify's width-only renditions; keep the exact observed winning URL. */
export function observedImageSizes(urls: readonly string[]): string[] {
  const images = new Map<string, { url: string; width: number }>();
  for (const url of urls) {
    const rendition = shopifyRendition(new URL(url));
    const key = rendition?.key ?? url;
    const width = rendition?.width ?? 0;
    const previous = images.get(key);
    if (!previous || width > previous.width) {
      images.set(key, { url, width });
    }
  }
  return [...images.values()].map((image) => image.url);
}

function shopifyImage(url: URL): boolean {
  return (
    /^\/cdn\/shop\/(?:files|products)\//.test(url.pathname) ||
    (url.hostname === "cdn.shopify.com" && /^\/s\/files\//.test(url.pathname))
  );
}

function shopifyRendition(url: URL): { key: string; width: number } | null {
  // Height, crop, format and unknown transforms may change the label's content or legibility.
  if (
    !shopifyImage(url) ||
    [...url.searchParams.keys()].some((key) => !["v", "width"].includes(key))
  ) {
    return null;
  }
  const widths = url.searchParams.getAll("width");
  if (widths.length > 1 || (widths[0] !== undefined && !/^[1-9]\d*$/.test(widths[0]))) {
    return null;
  }
  const width = widths[0] === undefined ? Infinity : Number(widths[0]);
  if (widths.length && !Number.isSafeInteger(width)) {
    return null;
  }
  url.searchParams.delete("width");
  url.searchParams.sort();
  return { key: url.href, width };
}
