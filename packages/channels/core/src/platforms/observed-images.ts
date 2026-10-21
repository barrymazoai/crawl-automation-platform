/**
 * Collapse only Shopify's width-only renditions of one file; keep the exact observed winning URL, never an invented
 * address. One file is served as `cdn.shopify.com/s/files/…/files/<name>` and as `<shop>/cdn/shop/files/<name>`, with
 * `?width=` or a legacy `<name>_86x.png` rendition (sambucolusa.com 2026-10-21: 13 gallery images came with 78
 * theme thumbnails under the shop host), so the file name and version identify the file, not the host.
 */
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

/** A theme asset (`/cdn/shop/t/<n>/assets/…`, e.g. a blank placeholder GIF) is never a product image. */
export function shopifyThemeAsset(url: URL): boolean {
  return /^\/cdn\/shop\/t\/\d+\/assets\//.test(url.pathname);
}

function shopifyRendition(url: URL): { key: string; width: number } | null {
  const parameter = widthParameter(url);
  if (!shopifyImage(url) || parameter === null) {
    return null;
  }
  const file = url.pathname.split("/").at(-1) ?? "";
  const legacy = /_([1-9]\d*)x(\.[a-z0-9]+)$/iu.exec(file);
  const name = legacy ? `${file.slice(0, legacy.index)}${legacy[2]}` : file;
  const width = Math.min(parameter, legacy ? Number(legacy[1]) : Infinity);
  return { key: `${name}?v=${url.searchParams.get("v") ?? ""}`, width };
}

/** The `?width=` rendition width, Infinity without one; null when any other transform or an odd width is present. */
function widthParameter(url: URL): number | null {
  // Height, crop, format and unknown transforms may change the label's content or legibility.
  if ([...url.searchParams.keys()].some((key) => !["v", "width"].includes(key))) {
    return null;
  }
  const widths = url.searchParams.getAll("width");
  if (widths.length === 0) {
    return Infinity;
  }
  const [width] = widths;
  if (widths.length > 1 || width === undefined || !/^[1-9]\d*$/.test(width)) {
    return null;
  }
  const value = Number(width);
  return Number.isSafeInteger(value) ? value : null;
}
