// Model-read ingredients of one warning letter. The model must quote the
// sentence for every ingredient; an item is kept only when that sentence is in
// the letter word for word and contains the name as the letter writes it.
export const PROMPT_VERSION = 'wl-ingredients-v1';

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
          quote: { type: 'string', description: 'One sentence copied word for word from the letter.' },
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
Do not include: a product itself (for example an imported food such as "tahini" in a supplier-verification letter, or a candy that contains an ingredient); nutrients or substances mentioned only in a rule, a definition or a labeling requirement; contaminants such as bacteria, filth or lead; cleaning or pest-control chemicals; substances named only in FDA's general warnings or URLs.
If a product name is itself an ingredient name (for example a product called "Maca Root Powder"), list that ingredient.
List each ingredient once. For "quote", copy one sentence from the letter exactly, including its punctuation; it must contain name_in_letter. If the letter names no ingredients, return an empty list. Do not guess.

Letter:
<<<
${letterText}
>>>`;
}

const normalize = (s) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export function verify(letterText, items) {
  const text = normalize(letterText);
  const kept = [];
  const dropped = [];
  const seen = new Set();
  for (const item of items) {
    const quote = normalize(item.quote ?? '');
    const name = normalize(item.name_in_letter ?? '');
    let reason = null;
    if (!quote || !text.includes(quote)) reason = 'quote_not_in_letter';
    else if (!name || !quote.includes(name)) reason = 'name_not_in_quote';
    else if (seen.has(normalize(item.name))) reason = 'duplicate';
    if (reason) dropped.push({ ...item, reason });
    else {
      seen.add(normalize(item.name));
      kept.push(item);
    }
  }
  return { kept, dropped };
}
