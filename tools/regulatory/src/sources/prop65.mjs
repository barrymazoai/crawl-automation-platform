// California AG Prop 65 60-day notices. No export or API: the search result
// pages are read month by month (100 per page) and only notices whose product
// ("Source") is a supplement-type product are kept. A notice is an allegation.
import * as cheerio from 'cheerio';
import { addDays, addMonths, format, startOfMonth, subMonths } from 'date-fns';
import { clean, isoDate, nullIfEmpty } from '../lib/text.mjs';
import { SUPPLEMENT_PRODUCT, NOT_SUPPLEMENT_PRODUCT } from './prop65-rules.mjs';

const ORIGIN = 'https://oag.ca.gov';
const PER_PAGE = 100;

const searchUrl = (from, to, page) =>
  `${ORIGIN}/prop65/60-day-notice-search-results?combine=&combine_1=&field_prop65_defendant_value=` +
  `&date_filter%5Bmin%5D%5Bdate%5D=${encodeURIComponent(format(from, 'MM/dd/yyyy'))}` +
  `&date_filter%5Bmax%5D%5Bdate%5D=${encodeURIComponent(format(to, 'MM/dd/yyyy'))}` +
  `&field_prop65_product_value=&sort_by=field_prop65_id_value&items_per_page=${PER_PAGE}&page=${page}`;

export function parsePage(html) {
  const $ = cheerio.load(html);
  const total = Number(clean($('.view-header').text()).match(/of\s+([\d,]+)\s+Notices/i)?.[1].replace(/,/g, '') ?? 0);
  const rows = $('.views-row')
    .map((_, el) => {
      const row = $(el);
      const field = (label) => {
        const box = row
          .find('.details-label')
          .filter((__, d) => clean($(d).find('.details').first().text()).replace(/:$/, '') === label)
          .first();
        return box.length ? box.children('div').last() : null;
      };
      const textOf = (label) => nullIfEmpty(field(label)?.text());
      const link = row.find('h3.ag-number a').first();
      const counts = clean(row.find('.field-name-field-prop65-type').text());
      const count = (name) => Number(counts.match(new RegExp(`${name} \\((\\d+)\\)`))?.[1] ?? 0);
      const chemicals = field('Chemical')
        ?.find('li')
        .map((__, li) => clean($(li).text()))
        .get();
      return {
        ag_number: clean(link.text()).match(/\d{4}-\d+/)?.[0] ?? null,
        detail_url: link.attr('href') ? new URL(link.attr('href'), ORIGIN).href : null,
        notice_pdf_url: field('Notice PDF')?.find('a').attr('href') ?? null,
        date_filed: isoDate(field('Date Filed')?.find('[content]').attr('content')) ?? isoDate(textOf('Date Filed')),
        noticing_party: textOf('Noticing Party'),
        plaintiff_attorney: textOf('Plaintiff Attorney'),
        alleged_violators: textOf('Alleged Violators'),
        chemical: chemicals?.length ? chemicals.join('; ') : textOf('Chemical'),
        source: textOf('Source'),
        complaints: count('Complaint'),
        settlements: count('Settlement'),
        judgments: count('Judgment'),
      };
    })
    .get();
  return { total, rows };
}

// Month windows keep each query small and its paging stable.
function windows(from, to) {
  const out = [];
  for (let start = from; start <= to; start = addMonths(startOfMonth(start), 1)) {
    const end = addDays(addMonths(startOfMonth(start), 1), -1);
    out.push([start, end > to ? to : end]);
  }
  return out;
}

function statusOf(n) {
  if (n.judgments > 0) return 'judgment';
  if (n.settlements > 0) return 'settled';
  if (n.complaints > 0) return 'complaint_filed';
  return 'notice_served';
}

export function isSupplementProduct(source) {
  return Boolean(source) && SUPPLEMENT_PRODUCT.test(source) && !NOT_SUPPLEMENT_PRODUCT.test(source);
}

export default {
  name: 'ca_prop65',
  kind: 'lawsuit',
  inventory: false,
  async collect({ http, log, now }) {
    const today = new Date(now);
    // Every run reads the last 12 months (~70 requests), so a notice's later
    // progress (complaint, settlement) is picked up without a separate reconcile.
    const from = startOfMonth(subMonths(today, 12));
    const notices = new Map();
    const stats = { windows: 0, pages: 0, notices_listed: 0, kept: 0 };
    for (const [start, end] of windows(from, today)) {
      stats.windows += 1;
      let expected = 0;
      for (let page = 0; ; page += 1) {
        const { total, rows } = parsePage(await http.text(searchUrl(start, end, page)));
        stats.pages += 1;
        expected = total;
        for (const r of rows) if (r.ag_number) notices.set(r.ag_number, r);
        if (rows.length < PER_PAGE || (page + 1) * PER_PAGE >= total) break;
      }
      log.info({ from: format(start, 'yyyy-MM-dd'), to: format(end, 'yyyy-MM-dd'), total: expected }, 'Prop 65 window');
    }
    stats.notices_listed = notices.size;
    const records = [];
    for (const n of notices.values()) {
      if (!isSupplementProduct(n.source)) continue;
      records.push({
        kind: 'lawsuit',
        source: 'ca_prop65',
        source_key: n.ag_number,
        source_url: n.detail_url ?? `${ORIGIN}/prop65/60-Day-Notice-${n.ag_number}`,
        title: `Prop 65 60-day notice ${n.ag_number}: ${n.chemical ?? 'chemical not listed'} in ${n.source}`,
        summary: `${n.noticing_party ?? 'A noticing party'} alleges that ${n.alleged_violators ?? 'the named businesses'} sold ${n.source} without a Proposition 65 warning for ${n.chemical ?? 'a listed chemical'}. This is a notice of alleged violation, not a finding.`,
        raw_company_name: n.alleged_violators,
        raw_company_address: null,
        raw_company_website: null,
        event_date: n.date_filed,
        published_date: n.date_filed,
        // Every lawsuit-kind record is an allegation; the notice's own progress is case_progress.
        status: 'alleged',
        status_date: null,
        details: {
          lawsuit_type: 'prop65_notice',
          case_progress: statusOf(n),
          plaintiff: n.noticing_party,
          plaintiff_attorney: n.plaintiff_attorney,
          court: null,
          chemical: n.chemical,
          allegation: 'Alleged failure to give a clear and reasonable Proposition 65 exposure warning',
          outlet: null,
          product: n.source,
          defendants: (n.alleged_violators ?? '').split(';').map(clean).filter(Boolean),
          notice_pdf_url: n.notice_pdf_url,
          complaints: n.complaints,
          settlements: n.settlements,
          judgments: n.judgments,
        },
        raw: n,
      });
    }
    stats.kept = records.length;
    return { records, stats, failures: [] };
  },
};
