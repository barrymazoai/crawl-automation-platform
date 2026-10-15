import { BrandWebsiteSchema, type BrandWebsiteOwner } from "@crawl-automation/v3-contracts";
import { checkedAnswer } from "./answer.js";
import type { ResearchArchive } from "./archive.js";
import { invalidAnswer } from "./errors.js";
import { citedPage, pageTexts, quotedPage } from "./page-grounding.js";
import type { WebsiteSubject } from "./inputs.js";
import { domainOf, normalizedText } from "./identity.js";
import type { RetainedPage } from "./archive.js";

/** Marketplaces and resellers are never a brand's official website (owner 2026-10-15). */
const MARKETPLACES = [
  "amazon.com",
  "walmart.com",
  "target.com",
  "ebay.com",
  "iherb.com",
  "vitacost.com",
  "luckyvitamin.com",
  "pipingrock.com",
  "vitaminshoppe.com",
  "cvs.com",
  "walgreens.com",
  "gnc.com",
  "swansonvitamins.com",
  "wholefoodsmarket.com",
  "costco.com",
];
/** A retailer's site is its own house brand's website, proven by the brand name carrying the retailer's name. */
const HOUSE_BRANDS: Record<string, string[]> = {
  "gnc.com": ["gnc"],
  "swansonvitamins.com": ["swanson"],
  "wholefoodsmarket.com": ["whole foods", "365"],
  "costco.com": ["kirkland"],
  "walmart.com": ["equate", "spring valley"],
  "target.com": ["up&up", "up & up"],
  "cvs.com": ["cvs"],
  "walgreens.com": ["walgreens"],
  "vitaminshoppe.com": ["vitamin shoppe"],
};

function refuseMarketplace(url: string, brandName: string) {
  const domain = domainOf(url);
  if (!domain) {
    invalidAnswer("website", "url_invalid");
  }
  const marketplace = MARKETPLACES.find((site) => domain === site || domain.endsWith(`.${site}`));
  const name = brandName.toLowerCase();
  if (marketplace && !(HOUSE_BRANDS[marketplace] ?? []).some((own) => name.includes(own))) {
    invalidAnswer("website", "marketplace_not_official");
  }
}

/** "Country Life, LLC (Iron Tek)" is printed as "Country Life": also try the name without notes and company forms. */
function brandNames(brandName: string): string[] {
  const plain = brandName
    .replace(/\([^)]*\)/gu, " ")
    .replace(/[,.]?\s+(llc|inc|corp|corporation|co|company|ltd|limited)\.?\s*$/iu, " ");
  return [...new Set([brandName, plain].map(normalizedText).filter(Boolean))];
}

/** The first of these names that is printed in the text (whole words), or undefined. */
function nameIn(texts: string[], names: string[]): string | undefined {
  const normalized = texts.map(normalizedText);
  return names.find((name) => normalized.some((text) => ` ${text} `.includes(` ${name} `)));
}

/**
 * Owner 2026-10-15: the homepage is proven by Codex's verbatim quote, or, when the quote is not found on the saved
 * page, by the brand's own name on that page. The stored quote is then the name actually found. An owner's homepage
 * (`owner` set) must print the owner's name, and that name is what is looked for.
 */
function provenHomepage(
  pages: RetainedPage[],
  answer: { url: string; quote: string },
  named: { brandName: string; owner: BrandWebsiteOwner | null },
): { page: RetainedPage; quote: string } {
  const page = citedPage(pages, answer.url);
  const name = nameIn(pageTexts(page), brandNames(named.owner?.name ?? named.brandName));
  if (named.owner && !name) {
    invalidAnswer("website", "owner_not_on_homepage");
  }
  try {
    quotedPage(pages, answer);
    return { page, quote: answer.quote };
  } catch (error) {
    if (!name) {
      throw error;
    }
    return { page, quote: name };
  }
}

/**
 * The brand has no site of its own and `url` is its owner's (owner 2026-10-15). The owner's quote is verbatim on a
 * saved page, names the owner, and that page names the brand; a search snippet alone is never proof.
 */
function provenOwner(pages: RetainedPage[], owner: BrandWebsiteOwner, brandName: string) {
  const page = quotedPage(pages, owner);
  if (!nameIn([owner.quote], brandNames(owner.name))) {
    invalidAnswer("website", "owner_not_in_quote");
  }
  if (!nameIn(pageTexts(page), brandNames(brandName))) {
    invalidAnswer("website", "brand_not_on_owner_page");
  }
  return page;
}

type Evidence = { url: string; observedAt: string };

/** The cited pages plus every saved page the check relied on. */
function withPages(evidence: Evidence[], pages: RetainedPage[]): Evidence[] {
  const missing = pages.filter((page) => !evidence.some((item) => item.url === page.url));
  return [...evidence, ...missing.map((page) => ({ url: page.url, observedAt: page.observedAt }))];
}

function citedEvidence(pages: RetainedPage[], cited: { url: string }[]): Evidence[] {
  return withPages(
    [],
    cited.map(({ url }) => citedPage(pages, url)),
  );
}

export function checkWebsiteAnswer(
  raw: unknown,
  archive: ResearchArchive,
  subject: WebsiteSubject,
) {
  const result = checkedAnswer(BrandWebsiteSchema, raw, "website");
  const evidence = citedEvidence(archive.pages, result.evidence);
  if (result.url === null) {
    return checkedAnswer(
      BrandWebsiteSchema,
      { ...result, quote: null, owner: null, evidence, archiveKeys: archive.archiveKeys },
      "website",
    );
  }
  if (!result.quote) {
    invalidAnswer("website", "quote_missing");
  }
  const { owner } = result;
  const ownerPage = owner ? provenOwner(archive.pages, owner, subject.brandName) : null;
  const { page, quote } = provenHomepage(
    archive.pages,
    { url: result.url, quote: result.quote },
    { brandName: subject.brandName, owner },
  );
  refuseMarketplace(page.url, subject.brandName);
  return checkedAnswer(
    BrandWebsiteSchema,
    {
      ...result,
      url: page.url,
      quote,
      owner: owner && ownerPage ? { ...owner, url: ownerPage.url } : null,
      evidence: withPages(evidence, ownerPage ? [page, ownerPage] : [page]),
      archiveKeys: archive.archiveKeys,
    },
    "website",
  );
}
