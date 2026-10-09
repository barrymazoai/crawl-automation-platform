import { BrandResearchSchema, FamilyFindingSchema } from "@crawl-automation/v3-contracts";
import { BrandCaptureRunner } from "./capture-runner.js";
import { checkFamilyAnswer } from "./family-answer.js";
import { familyPrompt } from "./family-prompt.js";
import type { BrandSubject } from "./inputs.js";
import { checkResearchAnswer } from "./research-answer.js";
import { researchPrompt } from "./research-prompt.js";
import { checkedDependencies, type BrandResearchDeps } from "./settings.js";
import { textTasks } from "./text-tasks.js";

export type { BrandResearchDeps } from "./settings.js";
export { brandResearchErrors } from "./errors.js";

/** Composition factory: five structural adapters for the application's frozen task ports. */
export function createBrandResearchTasks(deps: BrandResearchDeps) {
  const settings = checkedDependencies(deps);
  const capture = new BrandCaptureRunner(settings);
  return {
    familyCheck: {
      async check(subject: BrandSubject, signal: AbortSignal) {
        const saved = await capture.run(
          { task: "family", subject, schema: FamilyFindingSchema, prompt: familyPrompt },
          signal,
        );
        return checkFamilyAnswer(saved.result, saved, subject);
      },
    },
    researcher: {
      async research(subject: BrandSubject, signal: AbortSignal) {
        const saved = await capture.run(
          { task: "research", subject, schema: BrandResearchSchema, prompt: researchPrompt },
          signal,
        );
        return checkResearchAnswer(saved.result, saved);
      },
    },
    ...textTasks(settings),
  };
}
