import {
  TextOutputSchema,
  assertTextQuotes,
  type TextInput,
  type TextOutput,
  type TextRecord,
} from "@crawl-automation/v3-contracts";
import { verifyBytes } from "@crawl-automation/v3-artifacts";
import type { ObjectStore } from "@crawl-automation/platform";
import { textFailure, type ExecutionFact } from "../errors.js";
import { decodeTextResult } from "../protocol/text-protocol.js";
import {
  MAX_COMPLETION_BYTES,
  MAX_RESULT_BYTES,
  completionManifest,
  decodeJson,
  isOwnOutput,
} from "./text-record.js";

/** The stored output decodes to exactly its candidate under the task's protocol, with valid quotes. */
export function assertOutputMatchesSource(
  input: TextInput,
  output: TextOutput,
  source: { text: string; fact?: ExecutionFact },
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

/**
 * Whether `store` holds this record's result and completion, byte-exact, for this task and source text.
 * False when either file is missing; an error when they exist but do not match.
 */
export async function holdsVerifiedRecord(
  store: ObjectStore,
  check: { input: TextInput; record: TextRecord; sourceText: string },
  signal: AbortSignal,
): Promise<boolean> {
  const { input, record } = check;
  const [result, completion] = await Promise.all([
    store.read(record.result.objectKey, MAX_RESULT_BYTES, signal),
    store.read(record.completion.objectKey, MAX_COMPLETION_BYTES, signal),
  ]);
  if (!result || !completion) {
    return false;
  }
  verifyBytes(record.result, result, MAX_RESULT_BYTES);
  verifyBytes(record.completion, completion, MAX_COMPLETION_BYTES);
  const output = TextOutputSchema.parse(decodeJson(result));
  if (!isOwnOutput(input, output)) {
    throw textFailure("TEXT.RESULT_INTEGRITY");
  }
  assertOutputMatchesSource(input, output, { text: check.sourceText });
  const expected = completionManifest(input, record.result);
  if (JSON.stringify(decodeJson(completion)) !== JSON.stringify(expected)) {
    throw textFailure("TEXT.RESULT_INTEGRITY");
  }
  return true;
}
