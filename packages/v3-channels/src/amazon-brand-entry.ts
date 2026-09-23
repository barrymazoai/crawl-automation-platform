import { parseHTML } from 'linkedom';

export const brandEntryCode = (code: string): never => { throw new Error(`BRAND_ENTRY.${code}`); };
export function amazonEntryUrl(raw: string, base = 'https://www.amazon.com'): string {
  let u: URL; try { u = new URL(raw, base); } catch { return brandEntryCode('URL'); }
  if (u.protocol !== 'https:' || !['amazon.com', 'www.amazon.com'].includes(u.hostname) || u.port || u.username || u.password)
    return brandEntryCode('URL');
  u.hostname = 'www.amazon.com'; u.hash = '';
  for (const key of ['ref', 'ref_', 'tag', 'linkCode', 'linkId']) u.searchParams.delete(key);
  return u.href;
}
export function storeEntryUrl(raw: string, base?: string): string {
  const url = amazonEntryUrl(raw, base), path = new URL(url).pathname;
  if (!/^\/stores\/(?:[^/]+\/)?page\/[a-f0-9-]{36}\/?$/i.test(path)) return brandEntryCode('STORE_LINK_UNVERIFIED');
  return url;
}
export function seedBrand(html: string, asin: string, url: string) {
  if (/validateCaptcha|Robot Check|Enter the characters you see below/i.test(html)) return brandEntryCode('ACCESS_CHALLENGE');
  const { document } = parseHTML(html), main = document.querySelector('#ppd');
  const identities = [...(main?.querySelectorAll('#ASIN') ?? [])].map(e => e.getAttribute('value'));
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
  if (!main || !identities.length || identities.some(x => x !== asin) ||
      canonical && new URL(amazonEntryUrl(canonical, url)).pathname.match(/\/(?:dp|clp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/)?.[1] !== asin)
    return brandEntryCode('PRODUCT_IDENTITY');
  const links = main.querySelectorAll('#bylineInfo');
  if (links.length !== 1) return brandEntryCode('BRAND_LINK_MISSING');
  const byline = links[0]!, raw = (byline.textContent ?? '').replace(/\s+/g, ' ').trim();
  const name = raw.replace(/^Visit the\s+/i, '').replace(/\s+Store$/i, '').replace(/^Brand:\s*/i, '').trim();
  if (!name || name.length > 80 || /[\u0000-\u001f]/u.test(name)) return brandEntryCode('BRAND_NAME_UNVERIFIED');
  const href = byline.getAttribute('href');
  if (!href) return brandEntryCode('BRAND_LINK_MISSING');
  return { name, brandRaw: raw, storeUrl: storeEntryUrl(href, url) };
}

export type StoreLink = { text: string; href: string; navigation: boolean };
export function directoryLinks(links: StoreLink[], storeUrl: string) {
  const distinct = new Map<string, StoreLink>();
  for (const link of links) {
    let url: string; try { url = storeEntryUrl(link.href, storeUrl); } catch { continue; }
    const text = link.text.replace(/\s+/g, ' ').trim();
    if (text && text.length < 160) distinct.set(url, { ...link, text, href: url });
  }
  const all = [...distinct.values()].filter(l => /^(?:shop|view|see|browse)?\s*all(?:\s+(?:our\s+)?products|\s+items)?$/i.test(l.text));
  if (all.length > 1) return brandEntryCode('ALL_PRODUCTS_AMBIGUOUS');
  if (all.length) return { kind: 'all_products' as const, links: all };
  const categories = [...distinct.values()].filter(l => l.navigation && l.href !== storeEntryUrl(storeUrl) &&
    !/^(?:home|about(?: us)?|our (?:story|brand)|contact(?: us)?|faq|search|follow|brand story|posts)$/i.test(l.text));
  if (!categories.length) return brandEntryCode('DIRECTORY_MISSING');
  if (categories.length > 7) return brandEntryCode('NAVIGATION_LIMIT');
  return { kind: 'category_set' as const, links: categories };
}
