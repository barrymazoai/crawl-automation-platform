import { ApolloStepSchema, ReviewerVerdictSchema } from "@crawl-automation/v3-contracts";
import { apolloPrompt } from "./apollo-prompt.js";
import { checkApolloAnswer } from "./apollo-answer.js";
import { ownershipPrompt } from "./ownership-prompt.js";
import { checkOwnershipAnswer } from "./ownership-answer.js";
import { titlePrompt } from "./title-prompt.js";
import { checkTitleAnswer, TitlesAnswerSchema } from "./title-answer.js";
import { textAnswer } from "./text-runner.js";
import type { ApolloInput, ReviewerInput, TitlesInput } from "./inputs.js";
import type { BrandResearchDeps } from "./settings.js";

/** Factory of port adapters sharing the existing text-model execution template. */
export function textTasks(deps: BrandResearchDeps) {
  return {
    apolloJudge: {
      async next(input: ApolloInput, signal: AbortSignal) {
        const answer = await textAnswer(
          deps,
          { task: "apollo", prompt: apolloPrompt(input), schema: ApolloStepSchema },
          signal,
        );
        return checkApolloAnswer(answer, input);
      },
    },
    reviewer: {
      async review(input: ReviewerInput, signal: AbortSignal) {
        const answer = await textAnswer(
          deps,
          { task: "ownership", prompt: ownershipPrompt(input), schema: ReviewerVerdictSchema },
          signal,
        );
        return checkOwnershipAnswer(answer, input);
      },
    },
    titles: {
      async classify(input: TitlesInput, signal: AbortSignal) {
        if (!input.titles.length) {
          return [];
        }
        const answer = await textAnswer(
          deps,
          { task: "titles", prompt: titlePrompt(input), schema: TitlesAnswerSchema },
          signal,
        );
        return checkTitleAnswer(answer, input);
      },
    },
  };
}
