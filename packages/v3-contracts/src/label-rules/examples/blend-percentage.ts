import type { LabelRuleExamples, RowSubject } from "../index.js";
import { component } from "./rows.js";

const stored = "stored vision answer rejected as LABEL.AMOUNT_EVIDENCE_CONFLICT (2026-10-12 analysis)";

export const blendPercentageExamples: LabelRuleExamples<RowSubject> = {
  pass: [
    { subject: component("500 mg Turmeric root extract (95% curcuminoids) (Curcuma longa)", "500 mg"), source: stored },
    { subject: component("Green Tea (Camellia sinensis) (Leaf) Extract (std. to 50% EGCG)"), source: stored },
    { subject: component("Organic Kale (leaf), Standardized to 1% Nitrate"), source: stored },
    { subject: component("Organic Turmeric Root Extract standardized to 95% curcuminoids"), source: stored },
    { subject: component("Milk Thistle seed ext. (80% silymarin)"), source: stored },
    { subject: component("Horse Chestnut (Aesculus hippocastanum; Seed; Std. to 20% Aescin)", "300 mg"), source: stored },
    { subject: component("Linolenic Acid (Omega 3) 31-36%", "31-36%"), source: stored },
    { subject: component("Eicosapentaenoic acid (EPA) 18%", "18% equal to 180 mg"), source: stored },
    { subject: component("Beta Sitosterol 144 mg [40%]", "144 mg [40%]"), source: stored },
    { subject: component("Magnesium Taurinate (~8% Mg)", "750 mg"), source: stored },
  ],
  fail: [
    { subject: component("90% Whey"), source: "constructed: a share of the blend left out of the amount" },
    { subject: component("EPA 18%"), source: "constructed: a trailing share with no amount" },
    { subject: component("EPA 18%", "20%"), source: "constructed: amount percentage the name does not quote" },
  ],
};
