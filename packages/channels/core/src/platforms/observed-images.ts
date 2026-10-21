/**
 * Collapse only Shopify's width renditions of one file; keep the exact observed winning URL, never an invented
 * address. One file is served as `cdn.shopify.com/s/files/…/files/<name>` and as `<shop>/cdn/shop/files/<name>`
 * (sambucolusa.com 2026-10-21: 13 gallery images came with 78 theme thumbnails under the shop host), so the file name
 * and version identify it, not the host. A `?width=` rendition always collapses onto its file; a legacy `<name>_86x`
 * path collapses only when that file's unsized original was also observed, otherwise it is a file of its own.
 */
export function observedImageSizes(urls: readonly string[]): string[] {
  const originals = new Set(
    urls.flatMap((url) => {
      const rendition = shopifyRendition(new URL(url));
      return rendition && rendition.legacy === null ? [rendition.key] : [];
    }),
  );
  const images = new Map<string, { url: string; width: number }>();
  for (const url of urls) {
    const rendition = shopifyRendition(new URL(url));
    const aliased = rendition && (rendition.legacy === null || originals.has(rendition.key));
    const key = aliased ? rendition.key : url;
    const width = aliased ? rendition.width : 0;
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

/** The file's identity (name and version, host-independent), its effective width, and its legacy width suffix. */
function shopifyRendition(url: URL): { key: string; width: number; legacy: number | null } | null {
  const parameter = widthParameter(url);
  if (!shopifyImage(url) || parameter === null) {
    return null;
  }
  const file = url.pathname.split("/").at(-1) ?? "";
  const suffix = /_([1-9]\d*)x(\.[a-z0-9]+)$/iu.exec(file);
  const name = suffix ? `${file.slice(0, suffix.index)}${suffix[2]}` : file;
  const legacy = suffix ? Number(suffix[1]) : null;
  const width = Math.min(parameter, legacy ?? Infinity);
  return { key: `${name}?v=${url.searchParams.get("v") ?? ""}`, width, legacy };
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
