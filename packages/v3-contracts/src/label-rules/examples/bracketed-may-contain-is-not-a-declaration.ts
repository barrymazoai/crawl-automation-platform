import type { LabelRuleExamples } from "../index.js";

export const bracketedMayContainExamples: LabelRuleExamples<string> = {
  pass: [
    {
      subject:
        "colors (may contain black carrot, elderberry & beetroot concentrates, caramel color and beta carotene)",
      source: "B0GJHXSVDM vision-f50426b8 colors source",
    },
    {
      subject: "Paprika (may contain Silicon Dioxide)",
      source: "B001VNEHA4 vision-f8c83784 Paprika source",
    },
    {
      subject: "Rice Flour (contains: Soy Magnesium Stearate (vegetable), Silicon Dioxide)",
      source: "B0DMRLLT8K vision-f87b4ed5 bracketed subingredients",
    },
    {
      subject: "colors [may contain black carrot (concentrate)]",
      source: "constructed: nested square and round brackets",
    },
  ],
  fail: [
    {
      subject: "and citric acid. Contains: Soy",
      source: "B0GGVHWNNJ vision-e60f2644 top-level Contains",
    },
    {
      subject: "Organic Stevia Leaf Extract (Steviol Glycosides). Contains: Tree Nuts (Coconut)",
      source: "B0FR9LYNPF vision-f58f026d top-level Contains after parentheses",
    },
    {
      subject: "may contain stearic acid.",
      source: "B0B31VMXBY vision-e51034f6 top-level may contain",
    },
  ],
};
