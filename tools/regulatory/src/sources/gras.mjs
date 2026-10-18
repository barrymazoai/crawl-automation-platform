// FDA GRAS notice inventory. The export is a Latin-1 CSV with two lines of
// preamble. The FDA response letter link is only on each notice's own page,
// which is read when a notice is new or its CSV row changed.
import * as cheerio from 'cheerio';
import { parse } from 'csv-parse/sync';
import { clean, htmlText, isoDate, nullIfEmpty } from '../lib/text.mjs';
import { contentHash } from '../lib/store.mjs';

const EXPORT_URL = 'https://www.hfpappexternal.fda.gov/scripts/fdcc/cfc/XMLService.cfm?method=downloadxls&set=GRASNotices';
const itemUrl = (grn) => `https://www.hfpappexternal.fda.gov/scripts/fdcc/index.cfm?set=GRASNotices&id=${grn}`;

function responseStatus(text) {
  const t = (text ?? '').toLowerCase();
  const noQuestions = t.includes('no questions');
  const noBasis = t.includes('does not provide a basis');
  if (noQuestions && noBasis) return 'mixed';
  if (noQuestions) return 'no_questions';
  if (noBasis) return 'insufficient_basis';
  if (t.includes('ceased to evaluate')) return 'ceased_evaluation';
  if (t.includes('pending')) return 'pending';
  return t ? 'other' : null;
}

function itemLinks(html) {
  const $ = cheerio.load(html);
  const linkOf = (label) => {
    const th = $('th').filter((_, el) => clean($(el).text()).startsWith(label)).first();
    return th.length ? (th.next('td').find('a').first().attr('href') ?? null) : null;
  };
  return { letter: linkOf("FDA's Letter"), notice: linkOf('GRAS Notice') };
}

export default {
  name: 'fda_gras_inventory',
  kind: 'gras',
  inventory: true,
  completeList: true,
  async collect({ http, log, previous, refetchPages }) {
    const exported = await http.get(EXPORT_URL);
    const text = new TextDecoder('latin1').decode(exported.body);
    const csv = text.split(/\r?\n/).slice(2).join('\n');
    const rows = parse(csv, { columns: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, trim: false });
    log.info({ rows: rows.length, preamble: text.split(/\r?\n/)[0] }, 'GRAS export');

    const stats = { listed: rows.length, item_pages_read: 0, item_page_failures: 0 };
    const failures = [];
    const records = [];
    const listedKeys = new Set();
    for (const row of rows) {
      const grn = clean(row['GRAS Notice (GRN) No.']).replace(/^=T\("(.*)"\)$/, '$1');
      if (!grn) continue;
      listedKeys.add(grn);
      const fdaResponse = nullIfEmpty(htmlText(row["FDA's Letter"]).replace(/\s*\(in PDF\)\s*$/i, ''));
      const base = {
        kind: 'gras',
        source: 'fda_gras_inventory',
        source_key: grn,
        source_url: itemUrl(grn),
        title: `GRN ${grn}: ${htmlText(row.Substance)}`,
        summary: nullIfEmpty(htmlText(row['Intended Use'])),
        raw_company_name: nullIfEmpty(row.Notifier),
        raw_company_address: nullIfEmpty(htmlText(String(row['Notifier Address'] ?? '').replace(/<br\s*\/?>/gi, ', '))),
        raw_company_website: null,
        event_date: isoDate(row['Date of filing']),
        status: responseStatus(fdaResponse),
        status_date: isoDate(row['Date of closure']),
        raw: row,
      };
      // The item page is read again only when the CSV row changed.
      const prior = previous.get(`fda_gras_inventory|${grn}`);
      const rowUnchanged = prior && contentHash({ raw: prior.raw }) === contentHash({ raw: row });
      let links =
        rowUnchanged && !refetchPages
          ? { letter: prior.details.fda_response_letter_url, notice: prior.details.notice_url }
          : undefined;
      if (!links) {
        try {
          const page = await http.get(itemUrl(grn), { cache: refetchPages || prior ? 'fresh' : 'prefer' });
          links = itemLinks(page.body.toString('utf8'));
          stats.item_pages_read += 1;
        } catch (error) {
          if (error.name === 'HostBlockedError') throw error;
          stats.item_page_failures += 1;
          failures.push({ url: itemUrl(grn), error: error.message });
          links = prior ? { letter: prior.details.fda_response_letter_url, notice: prior.details.notice_url } : null;
        }
      }
      records.push({
        ...base,
        details: {
          grn,
          substance: htmlText(row.Substance),
          intended_use: nullIfEmpty(htmlText(row['Intended Use'])),
          basis: nullIfEmpty(row.Basis),
          fda_response: fdaResponse,
          fda_response_letter_url: links?.letter ?? null,
          notice_url: links?.notice ?? null,
          resubmission_of: nullIfEmpty(row.Resubmission),
          notes: nullIfEmpty(htmlText(row.Notes)),
        },
      });
    }
    return { records, listedKeys, stats, failures, notes: [`export header: ${text.split(/\r?\n/)[0]}`] };
  },
};
