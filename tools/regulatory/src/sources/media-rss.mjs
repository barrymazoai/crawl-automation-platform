// Trade-press RSS: litigation and enforcement items only. Stores the headline,
// the summary the feed itself carries and the link; article pages are never
// fetched. NutraIngredients-USA now publishes as nutraingredients.com and
// Natural Products Insider as SupplySide Supplement Journal (supplysidesj.com).
import { subMonths } from 'date-fns';
import { XMLParser } from 'fast-xml-parser';
import { htmlText, isoDate, nullIfEmpty } from '../lib/text.mjs';
import { ENFORCEMENT_NEWS, LAWSUIT_TYPES } from './media-rules.mjs';

const FEEDS = [
  {
    outlet: 'NutraIngredients',
    url: 'https://www.nutraingredients.com/arc/outboundfeeds/rss/',
    // The feed has no paging: only the latest 20 items are ever available.
    pageUrl: null,
  },
  {
    outlet: 'SupplySide Supplement Journal',
    url: 'https://www.supplysidesj.com/rss.xml',
    pageUrl: (n) => `https://www.supplysidesj.com/rss.xml?page=${n}`,
  },
];

const MAX_BACKFILL_PAGES = 40;

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
    source: 'trade_press_rss',
    source_key: url,
    source_url: url,
    title: item.title,
    summary: nullIfEmpty(item.description),
    raw_company_name: null,
    raw_company_address: null,
    raw_company_website: null,
    event_date: null,
    published_date: published && !Number.isNaN(published.getTime()) ? isoDate(published) : null,
    status: 'reported',
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
  name: 'trade_press_rss',
  kind: 'lawsuit',
  inventory: false,
  async collect({ http, log, mode, now }) {
    const cutoff = subMonths(new Date(now), 12);
    const records = [];
    const stats = {};
    for (const feed of FEEDS) {
      const s = { pages: 0, items: 0, kept: 0, oldest: null, newest: null };
      stats[feed.outlet] = s;
      const seen = new Set();
      const pages = mode === 'backfill' && feed.pageUrl ? MAX_BACKFILL_PAGES : 1;
      for (let n = 0; n < pages; n += 1) {
        const items = parseFeed(await http.text(n === 0 ? feed.url : feed.pageUrl(n)));
        s.pages += 1;
        const fresh = items.filter((i) => i.link && !seen.has(i.link));
        if (fresh.length === 0) break;
        for (const item of fresh) {
          seen.add(item.link);
          s.items += 1;
          const day = isoDate(item.pubDate ? new Date(item.pubDate) : null);
          if (day && (!s.oldest || day < s.oldest)) s.oldest = day;
          if (day && (!s.newest || day > s.newest)) s.newest = day;
          const record = toRecord(feed, item);
          if (record) records.push(record);
        }
        const oldest = fresh.map((i) => new Date(i.pubDate)).filter((d) => !Number.isNaN(d.getTime())).sort((a, b) => a - b)[0];
        if (oldest && oldest < cutoff) break;
      }
      s.kept = records.filter((r) => r.details.outlet === feed.outlet).length;
      log.info({ outlet: feed.outlet, ...s }, 'feed read');
    }
    return { records, stats, failures: [] };
  },
};
