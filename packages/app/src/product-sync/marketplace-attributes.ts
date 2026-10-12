import type { DeliveryItem } from "../product-delivery/wire.js";
import type { MarketplaceProduct } from "./marketplace-model.js";

export const objectFields = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const nonempty = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const dimensions = new Set(["flavor", "size", "strength", "form", "servings", "pack", "edition"]);

/** Read only named, selected options. Never infer a dimension from a title or choose a sibling option. */
export function marketplaceAttributes(input: MarketplaceProduct, item: DeliveryItem): DeliveryItem {
  const extras = objectFields(input.history?.metrics.extras);
  const commerce = objectFields(extras.commerce);
  const options = selectedOptions(input, extras, commerce);
  const structured = dimensionValues(options);
  const gtin = observedGtin([input.attributes, input.history?.metrics, extras, commerce]);
  return {
    ...item,
    ...(gtin ? { gtin } : {}),
    ...(Object.keys(structured).length
      ? {
          variant: { ...item.variant, ...structured },
          variantSource: "channel_attrs" as const,
        }
      : {}),
    attrsRaw: {
      ...item.attrsRaw,
      ...(input.attributes ? { attributes: input.attributes } : {}),
      ...(Object.keys(options).length ? { selectedOptions: options } : {}),
    },
  };
}
function dimensionValues(options: Record<string, unknown>) {
  const values: NonNullable<DeliveryItem["variant"]> = {};
  for (const [name, raw] of Object.entries(options)) {
    const key = name.toLowerCase().replace(/:\s*$/u, "").trim();
    const value = nonempty(raw);
    if (dimensions.has(key) && value) {
      values[key] = value;
    }
  }
  // Amazon explicitly prints both values in a single selected Size control.
  const size = typeof values.size === "string" ? values.size : undefined;
  const combined = size?.match(/^(.*?)\s*\(Pack of (\d+)\)$/iu);
  if (combined?.[1] && combined[2]) {
    values.size = combined[1].trim();
    values.pack ??= combined[2];
  }
  return values;
}
function namedOptions(options: string[]): Record<string, string> {
  return Object.fromEntries(
    options.flatMap((option) => {
      const colon = option.indexOf(":");
      return colon > 0 ? [[option.slice(0, colon), option.slice(colon + 1).trim()]] : [];
    }),
  );
}
function optionPairs(raw: unknown): Record<string, string> {
  if (!Array.isArray(raw)) {
    return {};
  }
  return Object.fromEntries(
    raw.flatMap((value) => {
      const pair = objectFields(value);
      const name = nonempty(pair.name);
      const text = nonempty(pair.value);
      return name && text ? [[name, text]] : [];
    }),
  );
}
function observedGtin(records: unknown[]) {
  const values = records
    .flatMap((record) => Object.entries(objectFields(record)))
    .filter(([key]) => /^(gtin(?:8|12|13|14)?|upc|ean|mpn)$/iu.test(key))
    .flatMap(([, value]) =>
      typeof value === "string" && /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/u.test(value.trim())
        ? [value.trim()]
        : [],
    );
  const unique = [...new Set(values)];
  // Conflicting codes are retained raw, never arbitrarily selected as a cross-channel merge key.
  return unique.length === 1 ? unique[0] : undefined;
}

function selectedOptions(
  input: MarketplaceProduct,
  extras: Record<string, unknown>,
  commerce: Record<string, unknown>,
) {
  const selected = input.product?.variants.find(
    (entry) =>
      entry.listingId === input.product?.listingId && entry.variantId === input.product.variantId,
  );
  const options = {
    ...namedOptions(input.product?.variantOptions ?? []),
    ...namedOptions(ownWebsiteOptions(input)),
    ...selected?.options,
    ...optionPairs(
      objectFields(extras.purchaseConditions ?? commerce.purchaseConditions).selectedOptions,
    ),
    ...objectFields(input.attributes),
  };
  return options;
}

function ownWebsiteOptions(input: MarketplaceProduct) {
  const subject = input.enrichment?.subject;
  return subject?.channel === input.channel ? (subject.websiteVariant?.options ?? []) : [];
}
