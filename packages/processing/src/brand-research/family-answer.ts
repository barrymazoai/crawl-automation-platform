import { FamilyFindingSchema } from "@crawl-automation/v3-contracts";
import { checkedAnswer } from "./answer.js";
import type { ResearchArchive } from "./archive.js";
import { invalidAnswer } from "./errors.js";
import { domainOf } from "./identity.js";
import type { BrandSubject } from "./inputs.js";
import { citedPage, quotedPage, retainedClues } from "./page-grounding.js";

export function checkFamilyAnswer(raw: unknown, archive: ResearchArchive, subject?: BrandSubject) {
  const result = checkedAnswer(FamilyFindingSchema, raw, "family");
  citedPage(archive.pages, result.landedUrl);
  checkRedirect(result, subject);
  for (const brand of result.subBrands) {
    quotedPage(archive.pages, brand.evidence);
  }
  const clues = retainedClues({
    clues: result.clues,
    pages: archive.pages,
    allowed: ["domain_redirect", "website_our_brands"],
  });
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
    { ...result, clues, archiveKeys: archive.archiveKeys },
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
