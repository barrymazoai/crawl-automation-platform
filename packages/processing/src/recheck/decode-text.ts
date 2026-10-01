import { assertTextQuotes, type TextInput } from "@crawl-automation/v3-contracts";
import { decodeLabelText } from "../text/protocol/label-decoder.js";

/** Current checks, preserving the saved task's wire protocol and exact citation scope. No I/O. */
export function recheckTextAnswer(input: TextInput, text: string, response: string) {
  const decoded = decodeLabelText({
    scope: input,
    text,
    response,
    policyVersion: input.policyVersion,
  });
  assertTextQuotes({ ...decoded.candidate, schemaVersion: 3 }, input, text);
  return decoded;
}
