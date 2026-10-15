import { getDomain } from "tldts";
import type { CompanySearchHit } from "@crawl-automation/v3-contracts";
import type { SupplySmartCompanies } from "./ports.js";

/**
 * Shared hosts: two sites on one of them are different businesses. The Public Suffix List already keeps most of them
 * apart (`x.myshopify.com`); these are the ones it does not, or that a candidate's domain may still name.
 */
const SHARED_HOSTS = new Set([
  "wordpress.com",
  "wixsite.com",
  "weebly.com",
  "squarespace.com",
  "godaddysites.com",
  "webflow.io",
  "myshopify.com",
  "blogspot.com",
  "netlify.app",
  "vercel.app",
  "github.io",
  "linktr.ee",
]);
/** Company forms and filler words that do not tell two names apart. */
const FILLER = new Set(
  "inc llc corp corporation co company ltd limited the brands brand usa us international intl group holdings".split(
    " ",
  ),
);
/** Below these lengths a shared prefix or a name inside a domain is a coincidence, not a clue. */
const MIN_PREFIX = 4;
const MIN_NAME_IN_DOMAIN = 5;

/** `us.myprotein.com` → `myprotein.com`; null when the site is already registrable or on a shared host. */
export function registrableDomain(domain: string): string | null {
  const root = getDomain(domain, { allowPrivateDomains: true });
  return root && root !== domain && !SHARED_HOSTS.has(root) ? root : null;
}

function words(value: string): string[] {
  return (
    value
      .normalize("NFKD")
      .replace(/[̀-ͯ]/gu, "")
      .toLowerCase()
      .replaceAll("&", " and ")
      .match(/[a-z0-9]+/gu) ?? []
  ).filter((word) => !FILLER.has(word));
}

function compact(value: string): string {
  return words(value).join("");
}

/** A domain as letters only (`www.`, dots and hyphens dropped), or null on a shared host. */
function siteKey(domain: string | null): string | null {
  if (!domain) {
    return null;
  }
  const [address = ""] = domain
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .split("/");
  const host = address.replace(/^www\./u, "");
  const root = getDomain(host, { allowPrivateDomains: true }) ?? host;
  return SHARED_HOSTS.has(root) ? null : host.replace(/[.-]/gu, "");
}

function sharesPrefix(left: string[], right: string[]): boolean {
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return (
    short.length > 0 &&
    short.join("").length >= MIN_PREFIX &&
    short.every((word, index) => long[index] === word)
  );
}

export interface IdentityCandidate {
  companyId: string;
  name: string;
  domain: string | null;
  productCount: number;
  why: string[];
}

/** Why this existing company may be the same business as the brand (empty: unrelated). */
function reasons(hit: CompanySearchHit, subject: { names: string[]; domain: string }): string[] {
  const why = new Set<string>();
  const hitSite = siteKey(hit.domain);
  for (const name of subject.names) {
    const ours = words(name);
    if (compact(hit.name) && compact(hit.name) === compact(name)) {
      why.add("same_name");
    } else if (sharesPrefix(words(hit.name), ours)) {
      why.add("name_prefix");
    }
    if (hitSite && compact(name).length >= MIN_NAME_IN_DOMAIN && hitSite.includes(compact(name))) {
      why.add("name_in_domain");
    }
  }
  if (hitSite && hitSite === siteKey(subject.domain)) {
    why.add("same_domain");
  }
  return [...why];
}

function queries(names: string[]): string[] {
  const all = names.flatMap((name) => {
    const first = words(name)[0] ?? "";
    return [name, compact(name), first.length >= MIN_PREFIX ? first : ""];
  });
  return [...new Set(all.map((query) => query.trim()).filter(Boolean))];
}

/**
 * Owner 2026-10-15: before a marketplace brand creates a company, look for an existing one under another site or
 * spelling (Trident Seafoods ↔ purealaskaomega.com, yumvs.com ↔ yum-vs.com, a company without a website). Any
 * candidate holds the creation for a person; nothing is linked or merged automatically.
 */
export async function identityCandidates(
  companies: Pick<SupplySmartCompanies, "search">,
  subject: { names: string[]; domain: string },
  signal: AbortSignal,
): Promise<IdentityCandidate[]> {
  const found = new Map<string, IdentityCandidate>();
  for (const query of queries(subject.names)) {
    for (const hit of await companies.search(query, signal)) {
      const why = reasons(hit, subject);
      if (why.length && !found.has(hit.id)) {
        found.set(hit.id, {
          companyId: hit.id,
          name: hit.name,
          domain: hit.domain,
          productCount: hit.productCount,
          why,
        });
      }
    }
  }
  return [...found.values()];
}
