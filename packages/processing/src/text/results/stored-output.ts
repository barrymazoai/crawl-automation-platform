import { assertTextQuotes, type TextInput, type TextOutput } from "@crawl-automation/v3-contracts";
import type { ExecutionFact } from "../../step/step-failure.js";
import { textFailure } from "../errors.js";
import { decodeTextResult } from "../protocol/text-protocol.js";

/** The stored output decodes to exactly its candidate under the task's protocol, with valid quotes. */
export function assertOutputMatchesSource(
  input: TextInput,
  output: TextOutput,
  source: { text: string; fact?: ExecutionFact | undefined },
): void {
  const decoded = decodeTextResult(input, source.text, output.rawResponse);
  if (JSON.stringify(decoded) !== JSON.stringify(output.candidate)) {
    throw textFailure("TEXT.RESULT_INTEGRITY", source.fact);
  }
  try {
    assertTextQuotes(output.candidate, input, source.text);
  } catch (error) {
    throw textFailure("TEXT.CITATION_INVALID", source.fact, error);
  }
}
