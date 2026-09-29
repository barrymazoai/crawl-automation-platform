import {
  TextCompatibilitySchema,
  parseTextInput,
  type TextActivityOutcome,
  type TextInput,
} from "@crawl-automation/v3-contracts";
import { textFailure } from "../errors.js";
import type { TextFacts, TextModel } from "../ports.js";
import { hashText } from "../results/text-record.js";

/** The model client must never retry, fall back to another model or switch network. */
export function assertSafeModel(model: TextModel): void {
  const policy = model.policy;
  const safe =
    policy.executionRetries === 0 &&
    policy.internalModelRequests === "no-retries" &&
    policy.toolAccess === "runtime-profile" &&
    policy.modelFallback === false &&
    policy.networkSwitching === false;
  if (!safe) {
    throw textFailure("TEXT.PROVIDER_POLICY", "not_executed");
  }
}

/** The task must be valid and for exactly the model setup this worker runs. */
export function admittedInput(raw: unknown, model: TextModel): TextInput {
  let input: TextInput;
  try {
    input = parseTextInput(raw, hashText);
  } catch (error) {
    throw textFailure("TEXT.INVALID_INPUT", "not_executed", error);
  }
  const expected = TextCompatibilitySchema.parse(model.supported);
  const keys = Object.keys(expected) as (keyof typeof expected)[];
  if (keys.some((key) => expected[key] !== input[key])) {
    throw textFailure("TEXT.INVALID_INPUT", "not_executed");
  }
  return input;
}

/** A result counts once registered, or, in cloud mode, once durable in R2. */
export function finishedOutcome(
  input: TextInput,
  facts: TextFacts,
  uploadOnly: boolean,
): TextActivityOutcome | null {
  const { record } = facts;
  if (!record || !facts.artifactDurable) {
    return null;
  }
  const refs = {
    operationId: input.operationId,
    result: record.result,
    completion: record.completion,
  };
  if (facts.resultRegistered) {
    return { status: "registered", ...refs };
  }
  return uploadOnly ? { status: "uploaded", ...refs } : null;
}
