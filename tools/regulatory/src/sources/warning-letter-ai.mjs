// Model-read ingredients of one warning letter. The model must quote the
// sentence for every ingredient; an item is kept only when that sentence is in
// the letter word for word and contains the name as the letter writes it.
// When the model shortened or re-punctuated the sentence but the name is in the
// letter, the letter's own sentence that best matches the quote replaces it.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { clip, sentences } from '../lib/text.mjs';

export const PROMPT_VERSION = 'wl-ingredients-v2';
const MIN_QUOTE_OVERLAP = 0.6;

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ingredients'],
  properties: {
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'name_in_letter', 'role', 'quote'],
        properties: {
          name: { type: 'string', description: 'Common English name, e.g. "vitamin C" for "Ascorbic Acid".' },
          name_in_letter: { type: 'string', description: 'The name exactly as the letter writes it.' },
          role: { type: 'string', enum: ['declared_or_used', 'undeclared_or_detected', 'named_in_claims'] },
          quote: { type: 'string', description: 'Text copied word for word from the letter.' },
        },
      },
    },
  },
};

export function buildPrompt(letterText) {
  return `You read an FDA warning letter and list the ingredients of the recipient's products that the letter names.

An ingredient is a substance that is, or is said to be, a component of a product the recipient makes or sells:
- declared on its label or used in its manufacture (role "declared_or_used");
- found by FDA testing, or present but not declared (role "undeclared_or_detected");
- named in the product claims the letter quotes as being in the product (role "named_in_claims").
Include botanicals, vitamins, minerals, amino acids, drugs and other actives, novel ingredients, and food allergens present in a product.
Do not include: a product itself (for example an imported food such as "tahini" or "corn flour" in a supplier-verification letter, or a candy that contains an ingredient); water; nutrients or substances mentioned only in a rule, a definition or a labeling requirement; contaminants such as bacteria, filth or lead; cleaning or pest-control chemicals; substances named only in FDA's general warnings or URLs; drugs that a product name only alludes to or translates to (for example "ampixilina" read as ampicillin).
If a product name is itself an ingredient name (for example a product called "Maca Root Powder"), list that ingredient.
List each ingredient once under one name: synonyms such as "riboflavin" and "vitamin B2" are one ingredient.
For "quote", copy a sentence, or a part of one, from the letter exactly as written: do not add or remove words or quotation marks. It must contain name_in_letter. If the letter names no ingredients, return an empty list. Do not guess.

Letter:
<<<
${letterText}
>>>`;
}

// Quote marks, dashes, FDA's [bracketed] edits and spacing do not count as differences.
const normalize = (s) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
const unquote = (s) => s.replace(/^["'\s]+|["'\s]+$/g, '');
const words = (s) => new Set(s.split(/[^a-z0-9]+/).filter((w) => w.length > 2));

// The letter sentence containing the name that shares most words with the
// model's quote, when it shares at least MIN_QUOTE_OVERLAP of them.
function bestSentence(letterSentences, name, quote) {
  const want = words(quote);
  let best = null;
  for (const original of letterSentences) {
    const candidate = normalize(original);
    if (!candidate.includes(name)) continue;
    const have = words(candidate);
    const overlap = want.size ? [...want].filter((w) => have.has(w)).length / want.size : 0;
    if (overlap >= MIN_QUOTE_OVERLAP && (!best || overlap > best.overlap)) best = { original, overlap };
  }
  return best;
}

export function verify(letterText, items) {
  const text = normalize(letterText);
  const letterSentences = letterText.split('\n').flatMap(sentences);
  const kept = [];
  const dropped = [];
  const seen = new Set();
  for (const item of items) {
    const quote = unquote(normalize(item.quote ?? ''));
    const name = normalize(item.name_in_letter ?? '');
    let result = item;
    let reason = null;
    if (!name || !text.includes(name)) reason = 'name_not_in_letter';
    else if (seen.has(normalize(item.name))) reason = 'duplicate';
    else if (!quote || !text.includes(quote) || !quote.includes(name)) {
      const best = bestSentence(letterSentences, name, quote);
      if (best) result = { ...item, quote: best.original, model_quote: item.quote, quote_repaired: true };
      else reason = text.includes(quote) ? 'name_not_in_quote' : 'quote_not_in_letter';
    }
    if (reason) dropped.push({ ...item, reason });
    else {
      seen.add(normalize(item.name));
      kept.push(result);
    }
  }
  return { kept, dropped };
}

// The text the model reads and its hash; a stored answer applies only while the
// letter text and the prompt are unchanged.
export const letterText = (letter) => letter.paragraphs.join('\n');
export const textHash = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
export const resultPath = (dataDir, slug) => join(dataDir, 'ai', 'warning-letter-ingredients', `${slug}.json`);
export const isCurrent = (result, text) => result?.prompt_version === PROMPT_VERSION && result.input_sha256 === textHash(text);

// Model ingredients replace the lexicon ones; the lexicon list stays in
// ingredients_rule for comparison.
export function applyModelIngredients(details, result) {
  return {
    ...details,
    ingredients_mentioned: result.ingredients.map((i) => i.name),
    ingredients_rule: details.ingredients_mentioned,
    ingredients_source: `model:${result.model}/${result.effort}/${result.prompt_version}`,
    ingredient_details: result.ingredients.map(({ name, name_in_letter, role, quote_repaired }) => ({
      name,
      name_in_letter,
      role,
      quote_repaired: Boolean(quote_repaired),
    })),
    evidence: [
      ...details.evidence.filter((e) => e.field !== 'ingredients_mentioned'),
      ...result.ingredients.map((i) => ({
        field: 'ingredients_mentioned',
        value: i.name,
        quote: clip(i.quote, 500),
        source: 'model',
      })),
    ],
  };
}
