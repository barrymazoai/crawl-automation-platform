import { scraperApiErrors } from "./scraperapi-errors.js";
import { allowedTarget } from "./scraperapi-settings.js";

const PROVIDER_HOST = "api.scraperapi.com";

/**
 * Where a refused redirect pointed, for the Review: the site-side address only (up to 300 characters). An address
 * on ScraperAPI itself, or one carrying a key, is never kept.
 */
export function redirectFacts(facts: {
  status: number;
  target: string;
  location?: string | null;
  finalUrl?: string | null;
}): Record<string, string | number> {
  const kept: Record<string, string | number> = { status: facts.status, target: facts.target };
  for (const name of ["location", "finalUrl"] as const) {
    const raw = facts[name];
    if (raw) {
      const safe = siteAddress(raw, facts.target);
      if (safe) {
        kept[name] = safe;
      }
    }
  }
  return kept;
}

function siteAddress(raw: string, base: string): string | null {
  const url = URL.parse(raw, base);
  if (!url) {
    return "(unparseable)";
  }
  const onProvider = url.hostname === PROVIDER_HOST || url.searchParams.has("api_key");
  return onProvider ? null : url.href.slice(0, 300);
}

/** The next address of a redirect that stays on an allowed site; null for any other redirect. */
export function allowedHop(
  location: string | null,
  target: URL,
  origins: readonly string[],
): URL | null {
  const url = location ? URL.parse(location, target) : null;
  if (!url) {
    return null;
  }
  try {
    return allowedTarget(url.href, origins);
  } catch (error) {
    // SOURCE.ORIGIN_BLOCKED is an expected refused hop; the caller records the redirect Review.
    if (scraperApiErrors.is(error, "SOURCE.ORIGIN_BLOCKED")) {
      return null;
    }
    throw error;
  }
}

export const isRedirect = (status: number) => status >= 300 && status < 400;
