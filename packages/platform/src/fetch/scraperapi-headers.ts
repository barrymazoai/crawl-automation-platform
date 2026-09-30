import { z } from "zod";

// Transport/proxy controls must never be overridden by a site's configured headers.
const reserved = /^(?:host|connection|content-length|transfer-encoding|proxy-.+|x-scraperapi-.+)$/i;
const name = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
  .refine((key) => !reserved.test(key));

/** Fixed startup configuration only; never populated from response headers or page content. */
export const ScraperApiHeadersSchema = z
  .record(
    name,
    z
      .string()
      .min(1)
      .max(8_192)
      .regex(/^[\x20-\x7e]+$/),
  )
  .refine((headers) => {
    const keys = Object.keys(headers).map((key) => key.toLowerCase());
    return keys.length <= 16 && new Set(keys).size === keys.length;
  })
  .transform((headers) =>
    Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
  );
