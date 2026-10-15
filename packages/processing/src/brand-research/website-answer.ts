import { BrandWebsiteSchema } from "@crawl-automation/v3-contracts";
import { checkedAnswer } from "./answer.js";
import type { ResearchArchive } from "./archive.js";
import { invalidAnswer } from "./errors.js";
import { citedPage, quotedPage } from "./page-grounding.js";
import type { WebsiteSubject } from "./inputs.js";
import { domainOf } from "./identity.js";

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
  const page = quotedPage(archive.pages, { url: result.url, quote: result.quote });
  refuseMarketplace(page.url, subject.brandName);
  return checkedAnswer(
    BrandWebsiteSchema,
    {
      ...result,
      url: page.url,
      evidence: evidence.some((item) => item.url === page.url)
        ? evidence
        : [...evidence, { url: page.url, observedAt: page.observedAt }],
      archiveKeys: archive.archiveKeys,
    },
    "website",
  );
}
