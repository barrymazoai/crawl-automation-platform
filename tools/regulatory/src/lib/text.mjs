import * as cheerio from 'cheerio';
import { isValid, parse } from 'date-fns';

export const clean = (s) => (s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

export const nullIfEmpty = (s) => {
  const v = clean(s);
  return v === '' ? null : v;
};

// Visible text of an HTML fragment (cells, RSS descriptions).
export const htmlText = (html) => clean(cheerio.load(`<div>${html ?? ''}</div>`)('div').first().text());

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

// Sentences of a paragraph; very short fragments ("Dr.", "No.") are joined to
// the next one so a quote is never cut at an abbreviation.
export function sentences(paragraph) {
  const out = [];
  let carry = '';
  for (const { segment } of segmenter.segment(paragraph)) {
    const s = carry + segment;
    if (s.trim().length < 25) {
      carry = s;
      continue;
    }
    out.push(clean(s));
    carry = '';
  }
  if (carry.trim()) out.push(clean(carry));
  return out;
}

// Accepts the date formats the sources use; returns YYYY-MM-DD or null.
export function isoDate(value, formats = ['MM/dd/yyyy', 'M/d/yyyy', 'MMM d, yyyy', 'MMMM d, yyyy']) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return isValid(value) ? value.toISOString().slice(0, 10) : null;
  const s = clean(String(value));
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  for (const f of formats) {
    const d = parse(s, f, new Date(0));
    if (isValid(d)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
}

// Cut long text at a sentence end, never mid-word.
export function clip(text, max = 800) {
  if (!text || text.length <= max) return text ?? null;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.” '));
  return end > max / 2 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))} …`;
}
