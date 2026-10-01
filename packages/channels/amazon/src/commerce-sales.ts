import type { CommerceEvidence } from "@crawl-automation/channels-core";
import { commerceText } from "./commerce-dom.js";
import type { AmazonElement } from "./dom.js";

/** A public badge is a qualified lower bound, never an exact sales count. */
export function salesVolume(root: AmazonElement): CommerceEvidence["salesVolume"] {
  const selector = "#socialProofingAsinFaceout_feature_div";
  const text = commerceText(root, selector);
  const match = text?.match(
    /^(\d+(?:,\d{3})*(?:\.\d+)?)([KM])?(\+)? bought in (?:the )?past (month|week)$/i,
  );
  if (!text || text.length > 1000 || !match) {
    return null;
  }
  return salesBadge({ text, match, selector });
}

function salesBadge(input: {
  text: string;
  match: RegExpMatchArray;
  selector: string;
}): CommerceEvidence["salesVolume"] {
  const { text, match, selector } = input;
  const multiplier = { K: 1000, M: 1_000_000 }[match[2]?.toUpperCase() ?? ""] ?? 1;
  const lowerBound = Number(match[1]?.replaceAll(",", "")) * multiplier;
  return Number.isSafeInteger(lowerBound) && lowerBound > 0
    ? {
        text,
        lowerBound: String(lowerBound),
        approximate: Boolean(match[2] || match[3]),
        period: match[4]?.toLowerCase() === "month" ? "past_month" : "past_week",
        selector,
      }
    : null;
}
