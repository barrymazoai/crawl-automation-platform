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
  /**
   * Image copy: two panels of one label (a facts table and a composition table) are read as one formula, each with
   * its own columns, unless they repeat each other. Off: a copy of two panels is not read by the copy rules.
   */
  readonly joinsPanels: boolean;
  /** Web text: the label check codes this market keeps for this answer (all of them by default). */
  textCodes(candidate: LabelTextCandidate, codes: readonly string[], text: string): string[];
}

/** The US rules: every label rule exactly as before markets existed. */
export const US_RULES: MarketLabelRules = {
  market: "us",
  copyPanels: (panels) => panels,
  joinsPanels: false,
  textCodes: (_candidate, codes) => [...codes],
};

/**
 * Owner 2026-11-07 (Naturaltein whey on amazon.in): an amino acid profile printed without a heading names itself in
 * its first column header ("Amino Acid Profile | Per 100g | …"); it is set aside like one with that heading.
 */
const AMINO_HEADER = /\bamino\s+acids?\b/i;

/** India (amazon.in): the US rules, plus the India-only rules below. */
export const INDIA_RULES: MarketLabelRules = {
  ...US_RULES,
  market: "in",
  copyPanels: (panels) =>
    panels.length > 1
      ? panels.filter((panel) => !AMINO_HEADER.test(panel.columnHeaders[0] ?? ""))
      : panels,
  // Owner 2026-11-07: Indian labels print the composition and the nutritional information as two tables (Neuherbs
  // fish oil, MuscleBlaze creatine, Health OK, LightYears, Earthful); 10 of the copies behind the label-protocol
  // readings of the 2026-11-06 batch were such pairs.
  joinsPanels: true,
};

/** The rules of the market whose label formats these are; US when absent or US-only. */
export function marketRules(formats: readonly LabelFormatId[] | undefined): MarketLabelRules {
  return isUsOnlyFormats(formats) ? US_RULES : INDIA_RULES;
}
