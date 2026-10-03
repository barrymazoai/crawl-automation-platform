import { z } from "zod";

const text = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((value) => (value == null ? undefined : String(value)));
const url = z
  .url()
  .nullish()
  .transform((value) => value ?? undefined);
const options = z
  .union([z.record(z.string(), z.string()), z.array(z.string())])
  .nullish()
  .transform((value) => {
    if (Array.isArray(value)) {
      return Object.fromEntries(value.map((item, index) => [`option${index + 1}`, item]));
    }
    return value ?? undefined;
  });

/** Convert website metadata shapes only; retain the original capture unchanged. */
export const CapturedVariantSchema = z
  .object({
    variantId: text,
    sku: text,
    title: text,
    url,
    options,
    price: text,
    currency: text,
    availability: text,
    available: z
      .boolean()
      .nullish()
      .transform((value) => value ?? undefined),
    imageUrl: url,
  })
  .passthrough()
  .partial();
