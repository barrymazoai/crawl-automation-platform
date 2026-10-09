import {
  ReviewerVerdictSchema,
  STRONG_OWNERSHIP_SIGNALS,
  type OwnershipClue,
} from "@crawl-automation/v3-contracts";
import { checkedAnswer } from "./answer.js";
import { invalidAnswer } from "./errors.js";
import { domainOf, sameText } from "./identity.js";
import type { ReviewerInput } from "./inputs.js";

/** A maker/distributor statement alone must never turn into an ownership signal. */
export function makerOnly(clue: OwnershipClue): boolean {
  return /^\s*(manufactured|distributed)\s+by\b/i.test(clue.quote);
}

export function checkOwnershipAnswer(raw: unknown, input: ReviewerInput) {
  const answer = checkedAnswer(ReviewerVerdictSchema, raw, "ownership");
  const usable = input.clues.filter((clue) => !makerOnly(clue));
  if (answer.verdict === "independent") {
    if (
      !input.checkedUrls.length ||
      usable.some((clue) => STRONG_OWNERSHIP_SIGNALS.includes(clue.signal))
    ) {
      invalidAnswer("ownership", "independence_without_checks_or_against_strong_clue");
    }
  }
  if (answer.verdict === "owner") {
    const matched = usable.filter(
      (clue) =>
        sameText(clue.ownerName, answer.ownerName) &&
        (answer.ownerDomain === null ||
          (clue.ownerDomain !== null &&
            domainOf(clue.ownerDomain) !== null &&
            domainOf(clue.ownerDomain) === domainOf(answer.ownerDomain))),
    );
    if (!answer.signals.every((signal) => matched.some((clue) => clue.signal === signal))) {
      invalidAnswer("ownership", "unsupported_owner_or_signal");
    }
    const cited = matched.filter((clue) => answer.signals.includes(clue.signal));
    if (
      !cited.some(
        (clue) =>
          clue.quote.trim() &&
          answer.reason.includes(clue.quote.trim()) &&
          (clue.url === null || answer.reason.includes(clue.url)),
      )
    ) {
      invalidAnswer("ownership", "reason_does_not_cite_evidence");
    }
  }
  return answer;
}
