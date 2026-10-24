import { isChallengeRedirect, scraperApiErrors } from "@crawl-automation/platform";
import type { HttpPolicy } from "../adapter.js";
import { channelErrors } from "../errors.js";

/** The ScraperAPI tier a channel escalates to once on a verification answer. */
export type ChallengeTier = "premium" | "ultraPremium";

/** The parts of a fetched page this check reads (the fetcher's own type, without importing it). */
interface FetchedPage {
  bytes: Uint8Array;
  fetchedVia: { creditCost?: number | null | undefined; finalUrl?: string | undefined };
}

/** What the first request met: a redirect to verification (no page), or the channel's verification page. */
export interface FirstChallenge {
  cause: "redirect" | "page";
  /** Unknown (null) after a refused redirect: the provider's cost header is never read. */
  creditCost: number | null;
  finalUrl?: string | undefined;
}

/** Lenient decoding: a page in another encoding is not a verification page, and is archived before it is read. */
const looseText = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);

/** A saved or fetched page that is the site's human verification: by where it landed, or by its content. */
export function isVerification(
  policy: HttpPolicy,
  page: { bytes: Uint8Array; url: string; finalUrl?: string | null | undefined },
): boolean {
  const landed = page.finalUrl ? isChallengeRedirect(page.finalUrl, new URL(page.url)) : false;
  return landed || (policy.accessChallenge?.(looseText(page.bytes)) ?? false);
}

/**
 * The first request's outcome: a page, a verification it met, or any other failure. Only a verification can be
 * escalated; `unwrap` returns the page or rethrows exactly what the request threw (the page itself is kept, so a
 * verification page without escalation is still archived and refused before it could become a sighting).
 */
export async function challenged<Page extends FetchedPage>(
  fetch: () => Promise<Page>,
  policy: HttpPolicy,
  url: string,
) {
  try {
    const page = await fetch();
    const { creditCost, finalUrl } = page.fetchedVia;
    const challenge: FirstChallenge | null = isVerification(policy, { ...page, url, finalUrl })
      ? { cause: "page", creditCost: creditCost ?? null, ...(finalUrl ? { finalUrl } : {}) }
      : null;
    return { challenge, unwrap: async () => page };
  } catch (error) {
    if (!scraperApiErrors.is(error, "SOURCE.ACCESS_CHALLENGE")) {
      throw error;
    }
    const landed = error.details["finalUrl"] ?? error.details["location"];
    const challenge: FirstChallenge = {
      cause: "redirect",
      creditCost: null,
      ...(typeof landed === "string" ? { finalUrl: landed } : {}),
    };
    return { challenge, unwrap: async (): Promise<Page> => Promise.reject(error) };
  }
}

/** Both requests' credits: unknown when the first one's is (owner rules: unknown stays null, never zero). */
export function bothCosts(first: FirstChallenge, second: number | null | undefined): number | null {
  return first.creditCost === null || second === null || second === undefined
    ? null
    : first.creditCost + second;
}

/** The escalated request also met verification: one Review code, naming the first request and the tier. */
export function stillChallenged(
  error: unknown,
  escalation: FirstChallenge & { tier: ChallengeTier },
) {
  if (!scraperApiErrors.is(error, "SOURCE.ACCESS_CHALLENGE")) {
    return error;
  }
  return channelErrors.create("CAPTURE.ACCESS_CHALLENGE", {
    details: { ...error.details, escalation },
    cause: error,
  });
}
