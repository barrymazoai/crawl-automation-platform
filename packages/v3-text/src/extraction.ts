// Moved to @crawl-automation/processing (text/protocol). Kept as names for the old workers until they retire.
import {
  resolveAnchor as placeQuote,
  type Anchor,
  type AnchorContext,
  type EvidenceLine,
} from "@crawl-automation/processing";

export {
  AnchoredExtractionSchema,
  anchoredPrompt,
  decodeTextResponse,
  evidenceLines,
  type AnchorContext,
} from "@crawl-automation/processing";

/** The old call shape: lines and text as separate arguments. */
export function resolveAnchor(
  anchor: Anchor,
  lines: readonly EvidenceLine[],
  text: string,
  context?: AnchorContext,
) {
  return placeQuote(anchor, { lines, text }, context);
}
