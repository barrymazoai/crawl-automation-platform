import { isUsOnlyFormats, type LabelFormatId } from "@crawl-automation/v3-contracts";
import type { LabelTranscriptWire } from "../../vision/protocol/label-transcript-wire.js";
import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";

type Panel = LabelTranscriptWire["panels"][number];

/**
 * Owner 2026-11-07 (KAN-243): each market's own label rules, so a change for one market never has to consider
 * another. The shared reading flow (copy, confirm every amount, store, push) calls these at its few market-specific
 * points; a market is chosen by the label formats its channel reads (amazon-in: India; every other channel: US).
 */
export interface MarketLabelRules {
  readonly market: "us" | "in";
  /** Image copy: the panels the copy rules read, from the panels a copy holds (after the shared choices). */
  copyPanels(panels: readonly Panel[]): readonly Panel[];
  /** Web text: the label check codes this market keeps for this answer (all of them by default). */
  textCodes(candidate: LabelTextCandidate, codes: readonly string[], text: string): string[];
}

/** The US rules: every label rule exactly as before markets existed. */
export const US_RULES: MarketLabelRules = {
  market: "us",
  copyPanels: (panels) => panels,
  textCodes: (_candidate, codes) => [...codes],
};

/** India (amazon.in): the US rules until an India-only rule is added here. */
export const INDIA_RULES: MarketLabelRules = {
  ...US_RULES,
  market: "in",
};

/** The rules of the market whose label formats these are; US when absent or US-only. */
export function marketRules(formats: readonly LabelFormatId[] | undefined): MarketLabelRules {
  return isUsOnlyFormats(formats) ? US_RULES : INDIA_RULES;
}
