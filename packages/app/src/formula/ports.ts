import type { SavedFormula } from "@crawl-automation/processing";
import type { KeywordResult } from "@crawl-automation/v3-contracts";

/** One product's key across the channels that share formulas with its own. */
export interface FormulaQuery {
  channels: readonly string[];
  listingId: string;
  variantId: string | null;
}

/** Collected formulas: this product's own (or a formula linked to it), and a saved formula's contents. */
export interface FormulaIndex {
  /** The newest formula for this product: collected for it, or linked to it from a sibling. */
  findKnown(query: FormulaQuery): Promise<{ operationId: string } | null>;
  /** A family member's formula: same listing, and the same variant when both name one. */
  findForMember(query: FormulaQuery): Promise<{ operationId: string } | null>;
  /** The formula and other ingredients a collected product stored; null when it has none. */
  readSaved(operationId: string): Promise<SavedFormula | null>;
}

/** A sibling's formula linked to a product that has none of its own, with the evidence of why. */
export interface FormulaLink {
  linkId: string;
  channel: string;
  listingId: string;
  variantId: string | null;
  formulaOperationId: string;
  sibling: { listingId: string; variantId: string | null };
  /** The family as the page showed it, the compared label text and the check's result. */
  evidence: Record<string, unknown>;
  runId: string;
}

/** Link records: written once; the same link again is read back, a different one is a conflict. */
export interface FormulaLinks {
  record(link: FormulaLink): Promise<FormulaLink>;
}

/**
 * The OCR text behind a facts image's keyword selection, read back from the registered OCR result and checked
 * against the selection (never text a caller passes in).
 */
export interface LabelImageText {
  verifiedText(selection: KeywordResult, signal: AbortSignal): Promise<string>;
}
