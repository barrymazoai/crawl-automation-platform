import { BrandResearchSchema } from "@crawl-automation/v3-contracts";
import { checkedAnswer } from "./answer.js";
import type { ResearchArchive } from "./archive.js";
import { invalidAnswer } from "./errors.js";
import { citedPage, retainedClues } from "./page-grounding.js";

export function checkResearchAnswer(raw: unknown, archive: ResearchArchive) {
  const result = checkedAnswer(BrandResearchSchema, raw, "research");
  const clues = retainedClues({
    clues: result.clues,
    pages: archive.pages,
    allowed: ["website_footer", "website_our_brands", "web_search"],
  });
  for (const url of result.checkedUrls) {
    citedPage(archive.pages, url);
  }
  const evidence = result.evidence.map(({ url }) => {
    const page = citedPage(archive.pages, url);
    return { url: page.url, observedAt: page.observedAt };
  });
  if (!evidence.length || (!clues.length && !result.checkedUrls.length)) {
    invalidAnswer("research", "profile_or_independence_evidence_missing");
  }
  return checkedAnswer(
    BrandResearchSchema,
    { ...result, clues, evidence, archiveKeys: archive.archiveKeys },
    "research",
  );
}
