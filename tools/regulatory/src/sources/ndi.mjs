// FDA NDI (75-day premarket) notification list. The XLSX link changes with
// every update, so it is looked up on the page by its file name each run. The
// sheet has FDA's response date but not its conclusion; that stays empty.
import * as cheerio from 'cheerio';
import ExcelJS from 'exceljs';
import { clean, isoDate, nullIfEmpty } from '../lib/text.mjs';

const PAGE_URL =
  'https://www.fda.gov/food/new-dietary-ingredient-ndi-notification-process/submitted-75-day-premarket-notifications-new-dietary-ingredients';

function findXlsxLink(html) {
  const $ = cheerio.load(html);
  const links = $('a[href*="/media/"]')
    .map((_, a) => ({ href: $(a).attr('href'), title: $(a).attr('title') ?? '', text: clean($(a).text()) }))
    .get()
    .filter((l) => /\.xlsx$/i.test(l.title) || /\bxlsx\b/i.test(l.text));
  const best = links.find((l) => /ndin/i.test(l.title)) ?? links[0];
  return best ? { url: new URL(best.href, PAGE_URL).href, file: best.title || best.text } : null;
}

// Cells may be plain values, formulas with a cached result, hyperlinks or rich text.
function cellValue(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return v.result instanceof Date ? v.result : (v.result ?? null);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return typeof v.text === 'object' ? (v.text?.richText?.map((t) => t.text).join('') ?? null) : v.text;
    if ('error' in v) return null;
  }
  return v;
}

export default {
  name: 'fda_ndi_list',
  kind: 'ndi',
  inventory: true,
  completeList: true,
  async collect({ http, log }) {
    const page = await http.text(PAGE_URL);
    const link = findXlsxLink(page);
    if (!link) throw new Error('NDI page has no XLSX link');
    const file = await http.get(link.url);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.body);
    const sheet = workbook.worksheets[0];
    const header = sheet.getRow(1).values.slice(1).map((h) => clean(cellValue({ value: h }) ?? ''));
    log.info({ file: link.file, url: link.url, rows: sheet.rowCount, header }, 'NDI sheet');

    const records = [];
    const stats = { listed: 0, unreadable_rows: 0 };
    sheet.eachRow((row, n) => {
      if (n === 1) return;
      const cells = header.map((_, i) => row.getCell(i + 1));
      const values = cells.map(cellValue);
      const ndin = values[0] === null ? null : clean(String(values[0]));
      if (!ndin || !/^\d+$/.test(ndin)) {
        if (values.some((v) => v !== null)) stats.unreadable_rows += 1;
        return;
      }
      stats.listed += 1;
      const ingredient = nullIfEmpty(values[2] === null ? null : String(values[2]));
      const firm = values[3] === null ? null : String(values[3]).trim() || null;
      const responseDate = isoDate(values[5]);
      const raw = Object.fromEntries(
        header.map((h, i) => [h || `column_${i + 1}`, values[i] instanceof Date ? values[i].toISOString().slice(0, 10) : values[i]]),
      );
      raw._ndin_link = cells[0].hyperlink ?? null;
      records.push({
        kind: 'ndi',
        source: 'fda_ndi_list',
        source_key: ndin,
        source_url: cells[0].hyperlink ?? PAGE_URL,
        title: `NDIN ${ndin}: ${ingredient ?? '(no ingredient name)'}`,
        summary: null,
        raw_company_name: firm,
        raw_company_address: null,
        raw_company_website: null,
        event_date: isoDate(values[4]),
        status: responseDate ? 'response_dated' : null,
        status_date: responseDate,
        details: {
          ndin,
          ingredient_name: ingredient,
          response_date: responseDate,
          // The list has neither FDA's conclusion nor a link to its letter.
          fda_response: null,
          response_letter_url: null,
          report_number: nullIfEmpty(values[1] === null ? null : String(values[1])),
        },
        raw,
      });
    });
    return { records, listedKeys: new Set(records.map((r) => r.source_key)), stats, failures: [], notes: [`list file: ${link.file} (${link.url})`] };
  },
};
