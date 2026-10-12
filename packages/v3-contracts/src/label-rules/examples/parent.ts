import type { LabelRuleExamples, RowSubject } from "../index.js";
import { column } from "./rows.js";

const candidase = column([
  ["blend_total", null, "Candidase® Enzyme Blend", "787.5 mg"],
  ["group_header", null, "Fiber-Digesting Enzyme"],
  ["blend_component", 0, "Cellulase Thera-blend® (60,000 CU)", "60,000 CU"],
  ["group_header", null, "Protein-Digesting Enzyme"],
  ["blend_component", 0, "Protease Thera-blend® (230,000 HUT)", "230,000 HUT"],
]);
const codLiver = column([
  ["nutrient", null, "Vitamin A (as Retinyl Palmitate)", "375 mcg"],
  ["blend_total", null, "Norwegian Cod Liver Oil", "415 mg"],
  ["group_header", null, "Typically Contains:"],
  ["blend_component", 1, "EPA (Eicosapentaenoic Acid) (Naturally Occurring)", "29 mg"],
]);
const tulsi = column([
  ["blend_total", null, "Proprietary Organic Blend", "1.7g"],
  ["blend_component", 0, "Organic Peppermint (leaf)"],
  ["blend_component", 0, "Organic Tulsi (Holy Basil) Blend"],
  ["blend_component", 2, "Holy Basil (Ocimum sanctum) (Krishna & Rama varieties)"],
]);
const herbal = column([
  ["blend_total", null, "Wellness Complex", "100 mg"],
  ["group_header", null, "Herbal Blend"],
  ["blend_component", 2, "Aloe vera leaf extract"],
]);
const unprintedBlend = column([
  ["blend_total", null, "Proprietary Blend"],
  ["group_header", null, "Sub-heading"],
  ["blend_component", 0, "Ingredient"],
]);
const twoSections = column([
  ["group_header", null, "Section A"],
  ["blend_component", 0, "Ingredient one"],
  ["group_header", null, "Section B"],
  ["blend_component", 0, "Ingredient two"],
]);

export const parentExamples: LabelRuleExamples<RowSubject> = {
  pass: [
    { subject: { rows: candidase, index: 2 }, source: "B00974SRHI vision-db36ed1f (sub-heading inside a blend)" },
    { subject: { rows: candidase, index: 4 }, source: "B00974SRHI vision-db36ed1f (second sub-heading)" },
    { subject: { rows: codLiver, index: 3 }, source: "DTC cod liver oil vision-2ed373ff (\"Typically Contains:\")" },
  ],
  fail: [
    { subject: { rows: tulsi, index: 3 }, source: "B000VDKZ1K vision-4ab4df40 (component under a component)" },
    { subject: { rows: herbal, index: 2 }, source: "stored answer pattern: row points at itself (46 of 411)" },
    { subject: { rows: twoSections, index: 3 }, source: "constructed: a new dose-free section still closes a heading-only group" },
    { subject: { rows: unprintedBlend, index: 2 }, source: "constructed: only a printed blend total stays open (review 2026-10-12)" },
  ],
};
