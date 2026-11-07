import type { LabelFormatId } from "@crawl-automation/v3-contracts";
import type { LabelTranscriptWire } from "../../vision/protocol/label-transcript-wire.js";

/**
 * Owner 2026-11-07 (KAN-243 spot check, The Whole Truth double cocoa plant protein on amazon.in): an Indian ingredient
 * list that gives each ingredient's share ends with the total ("pea protein isolate 51.8%, …, bromelain 0.4%, 100%").
 * The total is no ingredient: it leaves the copied list. A list without shares, or a share that is not the last item,
 * is kept as printed.
 */
const TOTAL = /\s*[,;]\s*100(?:\.0+)?\s*%\s*\.?\s*$/u;
const SHARE = /\d(?:\.\d+)?\s*%/u;

export function withoutIngredientTotal(
  wire: LabelTranscriptWire,
  formats: readonly LabelFormatId[],
): LabelTranscriptWire {
  const list = wire.otherIngredients;
  if (!formats.includes("in-composition/2") || !list || !TOTAL.test(list)) {
    return wire;
  }
  const items = list.replace(TOTAL, "");
  return SHARE.test(items) ? { ...wire, otherIngredients: items } : wire;
}
