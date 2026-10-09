import { FamilyFindingSchema, type OwnershipClue } from "@crawl-automation/v3-contracts";
import { checkedAnswer } from "./answer.js";
import type { ResearchArchive } from "./archive.js";
import { invalidAnswer } from "./errors.js";
import { domainOf } from "./identity.js";
import type { BrandSubject } from "./inputs.js";
import { citedPage, groundedPage, retainedClues } from "./page-grounding.js";

export function checkFamilyAnswer(raw: unknown, archive: ResearchArchive, subject?: BrandSubject) {
  const result = checkedAnswer(FamilyFindingSchema, raw, "family");
  citedPage(archive.pages, result.landedUrl);
  checkRedirect(result, subject);
  // A sub-brand whose evidence quote is not on its page, or does not name it, is dropped (owner 2026-10-09: Kate Farms'
  // shop collections "Everyday Adult" / "Everyday Kids" / "Medical Nutrition" were reported as sub-brands).
  const subBrands = result.subBrands.filter(
    (brand) => namesBrand(brand) && groundedPage(archive.pages, brand.evidence),
  );
  const shape = subBrands.length === 0 && result.shape !== "holding" ? "single" : result.shape;
  const clues = withObservedRedirect(
    retainedClues({
      clues: result.clues,
      pages: archive.pages,
      allowed: ["domain_redirect", "website_our_brands"],
    }),
    { result, archive },
  );
  const redirectClues = clues.filter((clue) => clue.signal === "domain_redirect");
  if ((!result.redirect || result.redirect.sameBrand) && redirectClues.length) {
    invalidAnswer("family", "same_brand_redirect_is_not_ownership");
  }
  if (
    result.redirect &&
    !result.redirect.sameBrand &&
    !redirectClues.some(
      (clue) =>
        clue.ownerDomain &&
        domainOf(clue.ownerDomain) === domainOf(result.redirect?.toDomain ?? ""),
    )
  ) {
    invalidAnswer("family", "cross_company_redirect_missing_clue");
  }
  return checkedAnswer(
    FamilyFindingSchema,
    { ...result, shape, subBrands, clues, archiveKeys: archive.archiveKeys },
    "family",
  );
}

function checkRedirect(
  result: ReturnType<typeof FamilyFindingSchema.parse>,
  subject?: BrandSubject,
) {
  if (!result.redirect) {
    return;
  }
  const from = domainOf(result.redirect.fromDomain);
  const to = domainOf(result.redirect.toDomain);
  if (!from || !to || from === to || to !== domainOf(result.landedUrl)) {
    invalidAnswer("family", "redirect_does_not_match_landing_domain");
  }
  if (subject?.brandUrl && from !== domainOf(subject.brandUrl)) {
    invalidAnswer("family", "redirect_does_not_start_at_subject_domain");
  }
}

/**
 * A cross-company forward the browser observed is itself the evidence: when Codex's own redirect clue was dropped
 * (misquoted), the clue is rebuilt from the observed forward and the saved landing page.
 */
function withObservedRedirect(
  clues: OwnershipClue[],
  at: { result: ReturnType<typeof FamilyFindingSchema.parse>; archive: ResearchArchive },
): OwnershipClue[] {
  const redirect = at.result.redirect;
  if (!redirect || redirect.sameBrand || clues.some((clue) => clue.signal === "domain_redirect")) {
    return clues;
  }
  const landing = citedPage(at.archive.pages, at.result.landedUrl);
  const owner = at.result.clues.find((clue) => clue.signal === "domain_redirect");
  return [
    ...clues,
    {
      signal: "domain_redirect",
      ownerName: owner?.ownerName ?? redirect.toDomain,
      ownerDomain: redirect.toDomain,
      ownerCompanyId: null,
      quote: `${redirect.fromDomain} forwards to ${at.result.landedUrl}`,
      url: at.result.landedUrl,
      archiveKey: landing.archiveKey,
    },
  ];
}

/** The evidence must name the sub-brand; a category blurb ("Daily nutrition for everyday enjoyment") does not. */
function namesBrand(brand: { name: string; evidence: { quote: string } }): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/gu, " ").trim();
  return normalize(brand.evidence.quote).includes(normalize(brand.name));
}
