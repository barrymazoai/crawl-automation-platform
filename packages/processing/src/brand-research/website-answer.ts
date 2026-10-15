import { BrandWebsiteSchema } from "@crawl-automation/v3-contracts";
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

/**
 * Owner 2026-10-15: the homepage is proven by Codex's verbatim quote, or, when the quote is not found on the saved
 * page, by the brand's own name on that page. The stored quote is then the name actually found.
 */
function provenHomepage(
  pages: RetainedPage[],
  answer: { url: string; quote: string },
  brandName: string,
): { page: RetainedPage; quote: string } {
  try {
    return { page: quotedPage(pages, answer), quote: answer.quote };
  } catch (error) {
    const page = citedPage(pages, answer.url);
    const texts = pageTexts(page).map(normalizedText);
    const name = brandNames(brandName).find((candidate) =>
      texts.some((text) => ` ${text} `.includes(` ${candidate} `)),
    );
    if (!name) {
      throw error;
    }
    return { page, quote: name };
  }
}

export function checkWebsiteAnswer(
  raw: unknown,
  archive: ResearchArchive,
  subject: WebsiteSubject,
) {
  const result = checkedAnswer(BrandWebsiteSchema, raw, "website");
  const evidence = result.evidence.map(({ url }) => {
    const page = citedPage(archive.pages, url);
    return { url: page.url, observedAt: page.observedAt };
  });
  if (result.url === null) {
    return checkedAnswer(
      BrandWebsiteSchema,
      { ...result, quote: null, evidence, archiveKeys: archive.archiveKeys },
      "website",
    );
  }
  if (!result.quote) {
    invalidAnswer("website", "quote_missing");
  }
  const { page, quote } = provenHomepage(
    archive.pages,
    { url: result.url, quote: result.quote },
    subject.brandName,
  );
  refuseMarketplace(page.url, subject.brandName);
  return checkedAnswer(
    BrandWebsiteSchema,
    {
      ...result,
      url: page.url,
      quote,
      evidence: evidence.some((item) => item.url === page.url)
        ? evidence
        : [...evidence, { url: page.url, observedAt: page.observedAt }],
      archiveKeys: archive.archiveKeys,
    },
    "website",
  );
}
