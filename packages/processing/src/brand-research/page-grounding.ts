import { DomUtils, parseDocument } from "htmlparser2";
import type { OwnershipClue, OwnershipSignal } from "@crawl-automation/v3-contracts";
import { brandResearchErrors, invalidAnswer } from "./errors.js";
import { makerOnly } from "./ownership-answer.js";
import type { RetainedPage } from "./archive.js";

export function citedPage(pages: RetainedPage[], url: string): RetainedPage {
  const page = pages.findLast((candidate) => candidate.url === url);
  if (!page) {
    throw brandResearchErrors.create("BRAND_RESEARCH.EVIDENCE_INVALID", {
      details: { url, reason: "page_not_retained" },
    });
  }
  return page;
}

export function quotedPage(pages: RetainedPage[], citation: { url: string; quote: string }) {
  const page = citedPage(pages, citation.url);
  const document = parseDocument(page.html);
  const texts = [DomUtils.innerText(document), DomUtils.textContent(document)];
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
  if (
    !normalize(citation.quote) ||
    !texts.some((text) => normalize(text).includes(normalize(citation.quote)))
  ) {
    throw brandResearchErrors.create("BRAND_RESEARCH.EVIDENCE_INVALID", {
      details: { url: citation.url, reason: "quote_not_in_page" },
    });
  }
  return page;
}

export function retainedClues(input: {
  clues: OwnershipClue[];
  pages: RetainedPage[];
  allowed: OwnershipSignal[];
}): OwnershipClue[] {
  return input.clues.map((clue) => {
    if (
      !clue.url ||
      !clue.quote.trim() ||
      !input.allowed.includes(clue.signal) ||
      makerOnly(clue)
    ) {
      invalidAnswer("browser", "unsupported_ownership_clue");
    }
    const page = quotedPage(input.pages, { url: clue.url, quote: clue.quote });
    return { ...clue, ownerCompanyId: null, archiveKey: page.archiveKey };
  });
}
