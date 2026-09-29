import {
  TextRecordSchema,
  parseTextInput,
  textIdentity,
  type TextInput,
  type TextOutput,
  type TextRecord,
} from "@crawl-automation/v3-contracts";
import { hashString, recordHash } from "../../results/result-record.js";

export const hashText = hashString;

/** A text task, checked against its schema and its own fingerprint. */
export const parseTextTask = (raw: unknown): TextInput => parseTextInput(raw, hashText);

/** A stored text record, checked against its schema and its task's own fingerprint. */
export function textRecord(raw: unknown): TextRecord {
  const record = TextRecordSchema.parse(raw);
  parseTextTask(record.input);
  return record;
}

export const hashRecord = (record: unknown) => recordHash({ parseRecord: textRecord }, record);

/** Where a task's result files live, locally and in R2. */
export const textKeys = {
  journal: (input: TextInput) => `text-completions/${input.operationId}.json`,
  response: (input: TextInput) => `text-responses/${input.operationId}.json`,
  intent: (input: TextInput) => `text-intents/${input.operationId}.json`,
  prefix: (input: TextInput) => `text-operations/${input.operationId}/${input.inputFingerprint}`,
};

/** The output's identity fields are exactly the task's. */
export function isOwnOutput(input: TextInput, output: TextOutput): boolean {
  const identity = textIdentity(input);
  return (Object.keys(identity) as (keyof typeof identity)[]).every(
    (key) => output[key] === identity[key],
  );
}
