// FDA warning letters. The list comes from the DataTables endpoint behind the
// warning-letter page (every letter, with its URL); the page's XLSX export
// stops at 1,000 rows and has no links. Letter pages of offices that never
// deal with supplements or food are not fetched; the rest are read once and
// kept in the cache, so a later run only fetches letters it has not seen.
import * as cheerio from 'cheerio';
import { readJson } from '../lib/store.mjs';
import { clean, clip, isoDate, nullIfEmpty, sentences } from '../lib/text.mjs';
import { applyModelIngredients, isCurrent, letterText, resultPath } from './warning-letter-ai.mjs';
import {
  ANIMAL_PRODUCT,
  DIETARY_SUPPLEMENT,
  DIETARY_SUPPLEMENT_TEXT,
  EXCLUDED_OFFICE,
  FDA_OFFICE_NAME,
  FOOD_OFFICE,
  FOOD_PRODUCT,
  MARKETPLACE,
  VIOLATION_EXCEPT,
  VIOLATION_RULES,
  WEBSITE_CONTEXT,
  domainsIn,
  matchIngredients,
} from './warning-letter-rules.mjs';

const ORIGIN = 'https://www.fda.gov';
const PAGE_SIZE = 1000;
const listUrl = (start) =>
  `${ORIGIN}/datatables/views/ajax?length=${PAGE_SIZE}&start=${start}` +
  '&view_name=warning_letter_solr_index&view_display_id=warning_letter_solr_block&draw=1';

const MAX_QUOTES = 2;

export function parseListRow(row) {
  const cell = (i) => cheerio.load(`<div>${row[i] ?? ''}</div>`);
  const link = cell(2)('a').first();
  const linkCell = (i) => {
    const $ = cell(i);
    const a = $('a').first();
    return a.length ? { url: new URL(a.attr('href'), ORIGIN).href, date: isoDate($('time').attr('datetime')) } : null;
  };
  const href = link.attr('href');
  return {
    url: new URL(href, ORIGIN).href,
    slug: href.split('/').filter(Boolean).at(-1),
    posted: isoDate(cell(0)('time').attr('datetime')),
    issued: isoDate(cell(1)('time').attr('datetime')),
    company: clean(link.text()),
    office: clean(cell(3)('div').text()),
    subject: clean(cell(4)('div').text()),
    response: linkCell(5),
    closeout: linkCell(6),
    excerpt: nullIfEmpty(cell(7)('div').text()),
  };
}

// Header fields, recipient block and paragraphs of one letter page.
export function parseLetter(html) {
  const $ = cheerio.load(html);
  const main = $('[role="main"]').first();
  const header = {};
  main.find('dl dt').each((_, dt) => {
    const label = clean($(dt).text()).replace(/:$/, '');
    const dd = $(dt).nextUntil('dt', 'dd');
    if (label === 'Recipient') {
      const company = dd.filter((__, el) => !$(el).find('.field, .address, a, span').length && clean($(el).text())).first();
      const address = dd.find('p.address').first();
      const part = (cls) => nullIfEmpty(address.find(`.${cls}`).text());
      const locality = [part('locality'), [part('administrative-area'), part('postal-code')].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', ');
      const lines = [part('address-line1'), part('address-line2'), locality, part('country')].filter(Boolean);
      const links = dd.find('a').map((__, a) => $(a).attr('href')).get();
      header.recipient = {
        name: nullIfEmpty(dd.find('.field--name-field-recipient-name .field--item').text()),
        title: nullIfEmpty(dd.find('.field--name-field-recipient-title .field--item').text()),
        company: nullIfEmpty(company.text()),
        address: lines.length ? lines.join(', ') : null,
        country: part('country'),
        email_domains: [
          ...new Set(
            links
              .filter((h) => h.startsWith('mailto:') && h.includes('@'))
              .map((h) => h.split('@').pop().trim().toLowerCase()),
          ),
        ],
        websites: links.filter((h) => /^https?:/i.test(h)),
      };
    } else if (label === 'Issuing Office') {
      header.office = nullIfEmpty(dd.first().text());
    } else {
      // Multi-valued fields are separated by <br> ("Dietary Supplements<br/>Drugs").
      const parts = (dd.first().html() ?? '')
        .split(/<br\s*\/?>/i)
        .map((part) => clean(cheerio.load(`<div>${part}</div>`)('div').text()))
        .filter(Boolean);
      header[label] = parts.length ? parts.join('; ') : null;
    }
  });
  // Claims quoted from websites are usually list items, not paragraphs.
  const paragraphs = main
    .find('p, li')
    .not('.address')
    .filter((_, el) => el.tagName === 'p' || $(el).find('p, li').length === 0)
    .map((_, p) => clean($(p).text()))
    .get()
    .filter(Boolean);
  return { header, paragraphs };
}

// Scope: dietary_supplement when the letter says so (Product field, subject or
// a sentence about the recipient's products); food when the Product field is
// human food or the letter comes from a central food office. Otherwise the
// letter is not collected.
function scopeOf(row, header, sentenceList) {
  const product = header.Product ?? null;
  if (product && DIETARY_SUPPLEMENT.test(product)) return { scope: 'dietary_supplement', basis: 'product_field', quote: product };
  if (DIETARY_SUPPLEMENT.test(row.subject)) return { scope: 'dietary_supplement', basis: 'subject', quote: row.subject };
  const quote = sentenceList.find((s) => DIETARY_SUPPLEMENT_TEXT.test(s.replace(FDA_OFFICE_NAME, '')));
  if (quote) return { scope: 'dietary_supplement', basis: 'letter_text', quote };
  if (product && FOOD_PRODUCT.test(product) && !ANIMAL_PRODUCT.test(product)) return { scope: 'food', basis: 'product_field', quote: product };
  if (FOOD_OFFICE.test(row.office)) return { scope: 'food', basis: 'issuing_office', quote: row.office };
  return null;
}

export function extract(row, letter) {
  const { header, paragraphs } = letter;
  const salutation = paragraphs.findIndex((p) => /^(Dear|To)\b/.test(p));
  const body = paragraphs.slice(salutation + 1);
  const sentenceList = body.flatMap(sentences);
  const scope = scopeOf(row, header, sentenceList);
  if (!scope) return { scope: null };

  const evidence = [];
  const violationTypes = [];
  for (const [type, patterns] of Object.entries(VIOLATION_RULES)) {
    const quotes = sentenceList
      .filter((s) => patterns.some((re) => re.test(s)) && !VIOLATION_EXCEPT[type]?.test(s))
      .slice(0, MAX_QUOTES);
    if (quotes.length === 0) continue;
    violationTypes.push(type);
    for (const quote of quotes) evidence.push({ field: 'violation_types', value: type, quote: clip(quote, 500) });
  }
  const ingredients = [];
  for (const s of sentenceList) {
    for (const name of matchIngredients(s)) {
      if (ingredients.includes(name)) continue;
      ingredients.push(name);
      evidence.push({ field: 'ingredients_mentioned', value: name, quote: clip(s, 500) });
    }
  }

  const recipient = header.recipient ?? {};
  const websites = [
    ...new Set([
      ...(recipient.websites ?? []).flatMap(domainsIn),
      ...sentenceList.filter((s) => WEBSITE_CONTEXT.test(s)).flatMap(domainsIn),
    ]),
  ];
  const ownSite = websites.find((d) => !MARKETPLACE.test(d)) ?? null;
  const summary = body.find((p) => p.length >= 120 && /FDA|Food and Drug Administration|inspect|review/i.test(p));

  return {
    scope,
    summary: clip(summary ?? null, 700),
    address: recipient.address ?? null,
    website: ownSite,
    details: {
      subject: row.subject,
      issuing_office: row.office,
      product_type: header.Product ?? null,
      scope: scope.scope,
      scope_basis: scope.basis,
      scope_quote: clip(scope.quote, 500),
      violation_types: violationTypes,
      ingredients_mentioned: ingredients,
      ingredients_source: 'rule',
      evidence,
      response_letter_url: row.response?.url ?? null,
      closeout_letter_url: row.closeout?.url ?? null,
      recipient_name: recipient.name ?? null,
      recipient_title: recipient.title ?? null,
      recipient_company: recipient.company ?? null,
      recipient_country: recipient.country ?? null,
      email_domains: recipient.email_domains ?? [],
      websites_mentioned: websites,
      delivery_method: header['Delivery Method'] ?? null,
    },
  };
}

function statusOf(row) {
  if (row.closeout) return { status: 'closed_out', status_date: row.closeout.date };
  if (row.response) return { status: 'response_posted', status_date: row.response.date };
  return { status: 'issued', status_date: row.issued };
}

export default {
  name: 'fda_warning_letters',
  kind: 'warning_letter',
  inventory: false,
  completeList: true,
  async collect({ http, log, refetchPages, dataDir }) {
    const rows = [];
    for (let start = 0; ; start += PAGE_SIZE) {
      const data = JSON.parse(await http.text(listUrl(start)));
      rows.push(...data.data);
      log.info({ start, got: data.data.length, total: data.recordsTotal }, 'warning letter list page');
      if (data.data.length < PAGE_SIZE || rows.length >= data.recordsTotal) break;
    }
    const stats = {
      listed: rows.length,
      excluded_office: 0,
      pages_read: 0,
      out_of_scope: 0,
      page_failures: 0,
      model_ingredients: 0,
      model_ingredients_stale: 0,
    };
    const records = [];
    const failures = [];
    const listedKeys = new Set();
    for (const raw of rows) {
      const row = parseListRow(raw);
      listedKeys.add(row.slug);
      if (EXCLUDED_OFFICE.test(row.office)) {
        stats.excluded_office += 1;
        continue;
      }
      let page;
      try {
        page = await http.get(row.url, { cache: refetchPages ? 'fresh' : 'prefer' });
      } catch (error) {
        if (error.name === 'HostBlockedError') throw error;
        stats.page_failures += 1;
        failures.push({ url: row.url, error: error.message });
        continue;
      }
      stats.pages_read += 1;
      const letter = parseLetter(page.body.toString('utf8'));
      const found = extract(row, letter);
      if (!found.scope) {
        stats.out_of_scope += 1;
        continue;
      }
      // Ingredients read by the model (src/ai-ingredients.mjs), when its answer
      // was made from this letter text with the current prompt.
      const model = await readJson(resultPath(dataDir, row.slug));
      if (model && isCurrent(model, letterText(letter))) {
        found.details = applyModelIngredients(found.details, model);
        stats.model_ingredients += 1;
      } else if (model) stats.model_ingredients_stale += 1;
      records.push({
        kind: 'warning_letter',
        source: 'fda_warning_letters',
        source_key: row.slug,
        source_url: row.url,
        title: `${row.company} — ${row.subject}`,
        summary: found.summary,
        raw_company_name: row.company,
        raw_company_address: found.address,
        raw_company_website: found.website,
        event_date: row.issued,
        published_date: row.posted,
        ...statusOf(row),
        details: found.details,
        raw: { list_row: raw, letter_fetched_at: page.fetchedAt },
        fetched_at: page.fetchedAt,
      });
    }
    return { records, listedKeys, stats, failures };
  },
};
