// Trade-press RSS: litigation and enforcement items only. Stores the headline,
// the summary the feed itself carries and the link; article pages are never
// fetched. NutraIngredients-USA now publishes as nutraingredients.com and
// Natural Products Insider as SupplySide Supplement Journal (supplysidesj.com).
import { XMLParser } from 'fast-xml-parser';
import { htmlText, isoDate, nullIfEmpty } from '../lib/text.mjs';
import { ENFORCEMENT_NEWS, LAWSUIT_TYPES } from './media-rules.mjs';

// Neither feed has paging or an archive (SupplySide ignores ?page=N), so a
// feed only ever shows its latest items: about 3 days for NutraIngredients
// (20 items) and about 7 weeks for SupplySide (50 items).
const FEEDS = [
  {
    outlet: 'NutraIngredients',
    source: 'media:nutraingredients',
    url: 'https://www.nutraingredients.com/arc/outboundfeeds/rss/',
  },
  {
    outlet: 'SupplySide Supplement Journal',
    source: 'media:supplysidesj',
    url: 'https://www.supplysidesj.com/rss.xml',
  },
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });
const textOf = (v) => (v === undefined || v === null ? null : typeof v === 'object' ? (v['#text'] ?? null) : String(v));
const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// Article identity: host + path, without tracking query or fragment.
function canonicalUrl(link) {
  const u = new URL(link);
  return `https://${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
}

function parseFeed(xml) {
  const channel = parser.parse(xml)?.rss?.channel;
  return asArray(channel?.item).map((item) => ({
    title: htmlText(textOf(item.title)),
    link: textOf(item.link),
    guid: textOf(item.guid),
    description: htmlText(textOf(item.description)),
    pubDate: textOf(item.pubDate),
    creator: textOf(item['dc:creator']),
    categories: asArray(item.category).map(textOf).filter(Boolean),
  }));
}

function toRecord(feed, item) {
  const text = `${item.title} ${item.description}`;
  const matched = ENFORCEMENT_NEWS.filter((re) => re.test(text)).map((re) => text.match(re)[0]);
  if (matched.length === 0) return null;
  const url = canonicalUrl(item.guid && /^https?:/.test(item.guid) ? item.guid : item.link);
  const published = item.pubDate ? new Date(item.pubDate) : null;
  return {
    kind: 'lawsuit',
    source: feed.source,
    source_key: url,
    source_url: url,
    title: item.title,
    summary: nullIfEmpty(item.description),
    raw_company_name: null,
    raw_company_address: null,
    raw_company_website: null,
    event_date: null,
    published_date: published && !Number.isNaN(published.getTime()) ? isoDate(published) : null,
    status: 'alleged',
    status_date: null,
    details: {
      lawsuit_type: LAWSUIT_TYPES.find(([, re]) => re.test(text))?.[0] ?? 'other',
      plaintiff: null,
      court: null,
      chemical: null,
      allegation: null,
      outlet: feed.outlet,
      matched_terms: [...new Set(matched.map((m) => m.toLowerCase()))],
      categories: item.categories,
    },
    raw: item,
  };
}

export default {
  name: 'media',
  kind: 'lawsuit',
  inventory: false,
  async collect({ http, log }) {
    const records = [];
    const stats = {};
    for (const feed of FEEDS) {
      const items = parseFeed(await http.text(feed.url));
      const days = items.map((i) => isoDate(i.pubDate ? new Date(i.pubDate) : null)).filter(Boolean).sort();
      const kept = items.map((item) => toRecord(feed, item)).filter(Boolean);
      records.push(...kept);
      stats[feed.outlet] = { items: items.length, kept: kept.length, oldest: days[0] ?? null, newest: days.at(-1) ?? null };
      log.info({ outlet: feed.outlet, ...stats[feed.outlet] }, 'feed read');
    }
    return { records, stats, failures: [] };
  },
};
