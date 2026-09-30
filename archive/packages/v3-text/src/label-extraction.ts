// Moved to @crawl-automation/processing (text/protocol). Kept as names for the old workers until they retire.
import type { TextInput } from "@crawl-automation/v3-contracts";
import { decodeLabelText as decodeLabel } from "@crawl-automation/processing";

export {
  labelTextInstructions,
  labelTextOutputSchema,
  labelTextPolicyVersion,
  labelTextPrompt,
  legacyLabelTextInstructions,
  v3LabelTextInstructions,
} from "@crawl-automation/processing";

/** The old call shape: scope, text, response and policy as separate arguments. */
export function decodeLabelText(
  scope: Pick<TextInput, "range">,
  text: string,
  response: string,
  policyVersion = "label-text/2",
) {
  return decodeLabel({ scope, text, response, policyVersion });
}
