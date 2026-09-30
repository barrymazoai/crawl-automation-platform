import { isIP } from "node:net";
import { z } from "zod";
import { scraperApiErrors } from "./scraperapi-errors.js";

const optionFields = {
  countryCode: z.string().regex(/^[a-z]{2}$/),
  /** Keeps requests on one provider session (a hint to ScraperAPI, not a fixed IP). */
  sessionNumber: z.number().int().min(0).max(2_147_483_647).nullable(),
  /** ScraperAPI renders the page in its own browser first (costs more credits). */
  render: z.boolean(),
  /** ScraperAPI uses premium residential proxies (costs more credits). */
  premium: z.boolean(),
};

/** How ScraperAPI fetches one page. The defaults are a plain US HTML fetch. */
export const ScraperApiOptionsSchema = z.strictObject({
  countryCode: optionFields.countryCode.default("us"),
  sessionNumber: optionFields.sessionNumber.default(null),
  render: optionFields.render.default(false),
  premium: optionFields.premium.default(false),
});
/** Some of the options, e.g. one channel's own; nothing is filled in, so absent ones keep their defaults. */
export const ScraperApiOptionChoicesSchema = z.strictObject(optionFields).partial();
export type ScraperApiOptions = z.output<typeof ScraperApiOptionsSchema>;

/** Whether an address is a plain public HTTPS page on one of the allowed sites (no IP, port, login or fragment). */
function isAllowed(url: URL, origins: readonly string[]): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const plain = !url.username && !url.password && !url.hash && !url.port;
  const named = !url.hostname.endsWith(".") && isIP(host) === 0;
  return url.protocol === "https:" && plain && named && origins.includes(url.origin);
}

/** The page address, refused unless it is on one of the allowed sites. */
export function allowedTarget(raw: string, origins: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw scraperApiErrors.create("SOURCE.ORIGIN_BLOCKED", { cause: error });
  }
  if (!isAllowed(url, origins)) {
    throw scraperApiErrors.create("SOURCE.ORIGIN_BLOCKED", { details: { origin: url.origin } });
  }
  return url;
}

/** An allowed site is written as its bare origin, e.g. `https://www.swansonvitamins.com`. */
function isOrigin(raw: string): boolean {
  const url = URL.parse(raw);
  return !!url && isAllowed(url, [url.origin]) && url.href === `${url.origin}/`;
}

/** The private part of the settings: the key and the sites it may be used for. Never logged or returned. */
export const ScraperApiAccessSchema = z.strictObject({
  apiKey: z
    .string()
    .min(8)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/),
  allowedOrigins: z.array(z.string().refine(isOrigin)).min(1).max(32),
});
export type ScraperApiAccess = z.output<typeof ScraperApiAccessSchema>;

/** Parses a schema, turning any mismatch into the client's config error without echoing the input. */
export function parseSettings<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw scraperApiErrors.create("SCRAPERAPI.CONFIG_INVALID");
  }
  return parsed.data;
}
