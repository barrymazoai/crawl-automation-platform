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
  try {
    const url = new URL(raw, base);
    const onProvider = url.hostname === PROVIDER_HOST || url.searchParams.has("api_key");
    return onProvider ? null : url.href.slice(0, 300);
  } catch {
    return "(unparseable)";
  }
}

/** The next address of a redirect that stays on an allowed site; null for any other redirect. */
export function allowedHop(
  location: string | null,
  target: URL,
  origins: readonly string[],
): URL | null {
  if (!location) {
    return null;
  }
  try {
    return allowedTarget(new URL(location, target).href, origins);
  } catch {
    return null;
  }
}

export const isRedirect = (status: number) => status >= 300 && status < 400;
