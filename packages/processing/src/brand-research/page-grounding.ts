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

/**
 * Owner 2026-10-09: a clue whose quote is not on its saved page is dropped, not fatal — one misquote must not fail
 * the brand. Codex's raw answer, dropped clues included, stays in the archived `records/result.json`.
 */
export function retainedClues(input: {
  clues: OwnershipClue[];
  pages: RetainedPage[];
  allowed: OwnershipSignal[];
}): OwnershipClue[] {
  return input.clues.flatMap((clue) => {
    if (
      !clue.url ||
      !clue.quote.trim() ||
      !input.allowed.includes(clue.signal) ||
      makerOnly(clue)
    ) {
      invalidAnswer("browser", "unsupported_ownership_clue");
    }
    const page = groundedPage(input.pages, { url: clue.url, quote: clue.quote });
    return page ? [{ ...clue, ownerCompanyId: null, archiveKey: page.archiveKey }] : [];
  });
}

/** The saved page that holds the quote, or null when the quote or the page is missing. */
export function groundedPage(pages: RetainedPage[], citation: { url: string; quote: string }) {
  try {
    return quotedPage(pages, citation);
  } catch (error) {
    if ((error as { code?: string }).code === "BRAND_RESEARCH.EVIDENCE_INVALID") {
      return null;
    }
    throw error;
  }
}
