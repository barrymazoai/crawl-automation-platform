import {
  isUsOnlyFormats,
  keywordPolicyFormats,
  type KeywordPolicy,
  type LabelFormatId,
} from "@crawl-automation/v3-contracts";
import type { LabelTranscriptWire } from "../../vision/protocol/label-transcript-wire.js";
import type {
  LabelCandidate,
  LabelImageCandidate,
  LabelTextCandidate,
} from "@crawl-automation/v3-contracts";
import type { OcrReading } from "../../keywords/ocr-text.js";
import {
  amountPositions,
  type AmountPositions,
} from "../../vision/protocol/label-amount-position.js";
import { proseAmounts } from "./india-prose-amounts.js";
import { sameIngredientsFormula } from "@crawl-automation/v3-contracts";
import type { TranscriptRow } from "../transcript/html-transcript.js";
import { compositionRows, compositionTextRows, compositionWire } from "./india-composition.js";

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
  /** Image copy: the copy as this market's labels print it, before any panel is read. */
  copyWire(wire: LabelTranscriptWire, formats: readonly LabelFormatId[]): LabelTranscriptWire;
  /** Image copy: a panel's rows read in this market's formats (the US panel is never reshaped). */
  copyRows(
    panel: { heading: string | null; servingLines: readonly string[] },
    rows: TranscriptRow[],
    formats: readonly LabelFormatId[],
  ): TranscriptRow[];
  /**
   * Merge: a partial reading's formula fits the selected one by this market's rule, where the shared agreement and
   * row matcher do not decide it.
   */
  formulaFits(
    partial: NonNullable<LabelCandidate["formula"]>,
    complete: NonNullable<LabelCandidate["formula"]>,
  ): boolean;
  /** Image copy: where the OCR prints each copied amount, after the table check (the US keeps that check alone). */
  amountPositions(
    candidate: LabelImageCandidate,
    ocr: OcrReading,
    at: { positions: AmountPositions; formats: readonly LabelFormatId[] },
  ): AmountPositions;
  /** Merge: a page's formula that differs from an image's formula yields to the label (a warning, no Review). */
  readonly pageFormulaYields: boolean;
  /** Web text: the answer as this market's labels print it, before it is checked. */
  textCandidate(candidate: LabelTextCandidate, formats: readonly LabelFormatId[]): void;
  /** Web text: the label check codes this market keeps for this answer (all of them by default). */
  textCodes(candidate: LabelTextCandidate, codes: readonly string[], text: string): string[];
}

/** The US rules: every label rule exactly as before markets existed. */
export const US_RULES: MarketLabelRules = {
  market: "us",
  copyPanels: (panels) => panels,
  joinsPanels: false,
  copyWire: (wire) => wire,
  copyRows: (_panel, rows) => rows,
  amountPositions: (_candidate, _ocr, at) => at.positions,
  formulaFits: () => false,
  textCandidate: () => undefined,
  pageFormulaYields: false,
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
  // Owner 2026-11-07: excipients, preservatives, colours and the base printed in a composition are not formula rows.
  copyWire: compositionWire,
  copyRows: compositionRows,
  // Owner 2026-11-07: the same ingredient and amount named shorter or longer is one reading of the label; a seller's
  // page that prints another amount than the label image (Rasayanam KSM-66: 500 mg, the label 600 mg) yields to it.
  amountPositions: proseAmounts,
  formulaFits: sameIngredientsFormula,
  textCandidate: compositionTextRows,
  pageFormulaYields: true,
};

/** The market of a product's label sources: the formats its images and page text are read in. */
export function sourcesMarket(
  sources: readonly (
    | { kind: "image"; task: { input: { selection: { policy: KeywordPolicy } } } }
    | { kind: "text"; task: unknown }
  )[],
): MarketLabelRules {
  // Each format once: a US product's two sources each read in the US format are still read in the US format only
  // (KAN-243 2026-11-07: counted twice, US products were merged with the India rules from 0611176c).
  const formats = [
    ...new Set(
      sources.flatMap((source) => {
        if (source.kind === "image") {
          return keywordPolicyFormats(source.task.input.selection.policy);
        }
        return (source.task as { labelFormats?: LabelFormatId[] }).labelFormats ?? [];
      }),
    ),
  ];
  return marketRules(formats.length ? formats : undefined);
}

/** Where the OCR prints each copied amount: the table check, then the market's own reading of it. */
export function marketAmountPositions(
  candidate: LabelImageCandidate,
  ocr: OcrReading,
  formats: readonly LabelFormatId[] | undefined,
): AmountPositions {
  return marketRules(formats).amountPositions(candidate, ocr, {
    positions: amountPositions(candidate, ocr),
    formats: formats ?? [],
  });
}

/** The rules of the market whose label formats these are; US when absent or US-only. */
export function marketRules(formats: readonly LabelFormatId[] | undefined): MarketLabelRules {
  return isUsOnlyFormats(formats) ? US_RULES : INDIA_RULES;
}
