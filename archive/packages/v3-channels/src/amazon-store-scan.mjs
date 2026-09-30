import { parseHTML } from 'linkedom';

// Amazon Brand Store scan: every page of one store, every product on it. Store pages have no sort, no page numbers and no
// total; products load while scrolling. A page is parsed only from its retained, fully loaded HTML.
const fail = code => { throw Error('STORE_SCAN.' + code); };
const text = e => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
const PAGE = /^\/stores\/(?:([^/?#]+)\/)?page\/([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\/?$/;
// A store page address: origin, optional store key and page id. Query and fragment (tracking, lp_asin, ingress) are dropped.
export function storeAddress(raw) {
  const u = new URL(raw, 'https://www.amazon.com');
  if (!['https://www.amazon.com', 'https://amazon.com'].includes(u.origin) || u.username || u.password) fail('URL');
  const m = u.pathname.match(PAGE); if (!m) fail('URL');
  const key = m[1] ? decodeURIComponent(m[1]) : null, pageId = m[2].toUpperCase();
  return { url: `https://www.amazon.com/stores/${m[1] ? m[1] + '/' : ''}page/${pageId}`, key, pageId };
}
// Same store: a link with the store's own key, or a keyless store page link (Amazon uses those for Shop All and sub-pages).
export const sameStore = (address, storeKey) => !address.key || !storeKey || address.key.toLowerCase() === storeKey.toLowerCase();
const tileOf = e => e.closest('li, [data-asin], [class*="ProductGridItem"], [class*="ProductCard"], [class*="Item__"]');
export function storePage(html, pageUrl, storeKey) {
  const address = storeAddress(pageUrl);
  if (/validateCaptcha|Robot Check|Enter the characters you see below/i.test(html)) fail('ACCESS_CHALLENGE');
  const { document: d } = parseHTML(html);
  for (const e of d.querySelectorAll('script,style,noscript')) e.remove();
  const products = new Map();
  // Sponsored: the tile carries an element whose own text is "Sponsored", or a sponsored marker class.
  const sponsoredTile = t => !!t && [t, ...t.querySelectorAll('*')].some(x => /sponsored/i.test(String(x.getAttribute?.('class') ?? '')) ||
    (x.children.length === 0 && text(x) === 'Sponsored'));
  const note = (asin, el) => { if (!/^[A-Z0-9]{10}$/.test(asin ?? '')) return; const s = sponsoredTile(tileOf(el)); products.set(asin, (products.get(asin) ?? false) || s); };
  for (const e of d.querySelectorAll('[data-asin]')) note(e.getAttribute('data-asin'), e);
  for (const a of d.querySelectorAll('a[href*="/dp/"]')) note(a.getAttribute('href').match(/\/dp\/([A-Z0-9]{10})(?:[/?#]|$)/)?.[1], a);
  const links = new Map(), srs = new Map();
  for (const a of d.querySelectorAll('a[href]')) {
    let u; try { u = new URL(a.getAttribute('href'), address.url); } catch { continue; }
    if (u.origin !== 'https://www.amazon.com') continue;
    if (/^\/s$/.test(u.pathname) && /^\d+$/.test(u.searchParams.get('srs') ?? '')) { srs.set(`https://www.amazon.com/s?srs=${u.searchParams.get('srs')}`, text(a).slice(0, 80)); continue; }
    let s; try { s = storeAddress(u.href); } catch { continue; }
    if (sameStore(s, storeKey) && s.pageId !== address.pageId && !links.has(s.pageId)) links.set(s.pageId, { url: s.url, text: text(a).slice(0, 80) });
  }
  const organic = [...products].filter(([, s]) => !s).map(([a]) => a), sponsored = [...products].filter(([, s]) => s).map(([a]) => a);
  const shopAll = [...links.values()].some(l => /^(shop|view|see|browse)?\s*all(\s+(our\s+)?products|\s+items)?$/i.test(l.text));
  return { url: address.url, pageId: address.pageId, title: text(d.querySelector('title')).slice(0, 200), organic, sponsored,
    links: [...links.values()], srsLinks: [...srs].map(([url, t]) => ({ url, text: t })), shopAll };
}
