import { scraperApiErrors } from "./scraperapi-errors.js";
import { allowedTarget } from "./scraperapi-settings.js";

const PROVIDER_HOST = "api.scraperapi.com";

/** Explicit verification markers, not arbitrary tracking parameters or similarly named products. */
export function isChallengeRedirect(location: string | null, target: URL): boolean {
  const url = location ? URL.parse(location, target) : null;
  if (!url || url.origin !== target.origin) {
    return false;
  }
  return (
    [...url.searchParams.keys()].some(
      (key) => key === "__shopify_bv_challenge" || key.startsWith("__cf_chl_"),
    ) ||
    // Amazon's "Continue shopping" interstitial and its captcha (owner 2026-10-24: recorded as delistings before).
    /^\/(?:challenge(?:\/|$)|cdn-cgi\/challenge-platform\/|checkpoint\/|errors\/validatecaptcha)/i.test(
      url.pathname,
    )
  );
}

/**
 * The listing a same-site landing page shows instead of its product page: Amazon's "Your pick" page `/clp/<ASIN>`
 * (page type ContextualLandingPage; owner 2026-10-26: 96 such redirects were recorded as delistings), optionally
 * with Amazon's `/ref=…` segment. Null for any other address. Kept beside the challenge markers because both the
 * capture (channels-core) and the reuse admission (Postgres adapter, which knows only the channel id) need it.
 */
export function landingPageListing(location: string | null, target: URL): string | null {
  const url = location ? URL.parse(location, target) : null;
  if (!url || url.origin !== target.origin) {
    return null;
  }
  return /^\/clp\/([^/]+)(?:\/ref=[^/]*)?\/?$/i.exec(url.pathname)?.[1] ?? null;
}

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
  if (!url || isChallengeRedirect(location, target)) {
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

export function redirectError(facts: Parameters<typeof redirectFacts>[0], privateHeaders: boolean) {
  const challenge = isChallengeRedirect(
    facts.location ?? facts.finalUrl ?? null,
    new URL(facts.target),
  );
  return scraperApiErrors.create(
    challenge ? "SOURCE.ACCESS_CHALLENGE" : "SCRAPERAPI.REDIRECT_UNVERIFIED",
    { details: privateHeaders ? { status: facts.status } : redirectFacts(facts) },
  );
}
