import {
  BrandResearchSchema,
  BrandWebsiteSchema,
  FamilyFindingSchema,
} from "@crawl-automation/v3-contracts";
import { BrandCaptureRunner } from "./capture-runner.js";
import { checkFamilyAnswer } from "./family-answer.js";
import { familyPrompt } from "./family-prompt.js";
import type { BrandSubject, WebsiteSubject } from "./inputs.js";
import { checkResearchAnswer } from "./research-answer.js";
import { researchPrompt } from "./research-prompt.js";
import {
  checkedDependencies,
  checkedTextDependencies,
  type BrandResearchDeps,
  type BrandTextDeps,
} from "./settings.js";
import { textTasks } from "./text-tasks.js";
import { checkWebsiteAnswer } from "./website-answer.js";
import { websitePrompt } from "./website-prompt.js";

export type { BrandResearchDeps, BrandTextDeps } from "./settings.js";
export { brandResearchErrors } from "./errors.js";

/** The three tool-free text turns (Apollo judge, ownership reviewer, titles); they need only the text model. */
export function createBrandTextTasks(deps: BrandTextDeps) {
  return textTasks(checkedTextDependencies(deps));
}

/** The browser tasks (family check, research, website lookup), each in its own Ego page. */
export function createBrandBrowserTasks(deps: BrandResearchDeps) {
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
    websiteFinder: {
      async find(subject: WebsiteSubject, signal: AbortSignal) {
        const saved = await capture.run(
          { task: "website", subject, schema: BrandWebsiteSchema, prompt: websitePrompt },
          signal,
        );
        return checkWebsiteAnswer(saved.result, saved, subject);
      },
    },
  };
}

/** Composition factory: all structural adapters for the application's frozen task ports. */
export function createBrandResearchTasks(deps: BrandResearchDeps) {
  return { ...createBrandBrowserTasks(deps), ...createBrandTextTasks(deps) };
}
