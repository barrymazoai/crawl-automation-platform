import type { LabelEquivalenceExamples } from "../index.js";

export const servingSizeExamples: LabelEquivalenceExamples = {
  same: [
    { subject: ["1 Capsule", "1 Capsule(s)"], source: "GNC 539600 label-d1446899 (image vs page, 2026-10-12)" },
    { subject: ["2 Caplet(s)", "Two Caplets"], source: "owner 2026-10-09 (GNC)" },
    { subject: ["1 Scoop(s)", "1 Scoop (22g)"], source: "owner 2026-10-09 (GNC)" },
    { subject: ["1 Level Scoop", "1 level scoop (5 g)"], source: "owner 2026-10-08" },
    { subject: ["5 g", "5g"], source: "owner 2026-10-08" },
  ],
  different: [
    { subject: ["1 capsule", "2 capsules"], source: "serving-size.test (2026-10-08)" },
    { subject: ["1 Scoop (Approx. 1 g)", "1 Scoop (Approx. 19g)"], source: "serving-size.test (2026-10-08)" },
    { subject: ["1 scoop (25 g)", "1 scoop (30 g)"], source: "serving-size.test (2026-10-08)" },
    { subject: ["1", "1 scoop"], source: "serving-size.test: a bare number names no unit" },
  ],
};
