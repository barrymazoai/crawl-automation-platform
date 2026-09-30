import { channelErrors } from "../errors.js";
import { platformPageErrors } from "./errors.js";

export function pageUrl(raw: string, base: string): string {
  const url = new URL(raw, base);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw channelErrors.create("CHANNEL.URL_REJECTED", { details: { url: raw } });
  }
  url.hash = "";
  return url.href;
}

export function samePage(left: string, right: string): boolean {
  const one = new URL(left);
  const two = new URL(right);
  return (
    one.origin === two.origin && one.pathname.replace(/\/$/, "") === two.pathname.replace(/\/$/, "")
  );
}

/** Only page-owned metadata, never the requested address as an identity fallback. */
export function canonicalUrl(document: Document, base: string): string | null {
  const links = [...document.querySelectorAll('link[rel="canonical"]')]
    .map((node) => node.getAttribute("href"))
    .filter((url) => url !== null)
    .map((url) => pageUrl(url, base));
  if (new Set(links).size > 1) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  return links[0] ?? null;
}

export function variantUrl(url: string, key: string, value: string): string {
  const target = new URL(url);
  target.search = "";
  target.searchParams.set(key, value);
  return target.href;
}
