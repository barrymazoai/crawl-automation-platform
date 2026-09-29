import {
  TextOutputSchema,
  textIdentity,
  type ArtifactRef,
  type TextInput,
  type TextOutput,
  type TextRecord,
} from "@crawl-automation/v3-contracts";
import type { RecordCodec, ResultFailureReason, ResultKind } from "../../results/result-kind.js";
import { textFailure, type TextErrorCode } from "../errors.js";
import { textLimits } from "../limits.js";
import type { TextSource } from "../ports.js";
import { assertOutputMatchesSource } from "./stored-output.js";
import { hashText, isOwnOutput, parseTextTask, textKeys, textRecord } from "./text-record.js";

const failureCodes: Record<ResultFailureReason, TextErrorCode> = {
  conflict: "TEXT.RESULT_CONFLICT",
  integrity: "TEXT.RESULT_INTEGRITY",
  incomplete: "TEXT.HANDOFF_INCOMPLETE",
  notYetDurable: "TEXT.HANDOFF_INCOMPLETE",
  unknown: "TEXT.HANDOFF_UNKNOWN",
  registeredNotDurable: "TEXT.RESULT_NOT_DURABLE",
  sourceNotDurable: "TEXT.SOURCE_NOT_DURABLE",
  registryUnavailable: "TEXT.REGISTRY_UNAVAILABLE",
  outputLimit: "TEXT.OUTPUT_LIMIT",
};

/** Text records in the ledger, with the codes text Reviews already carry. */
export const textRecordCodec: RecordCodec<TextRecord> = {
  parseRecord: textRecord,
  fail: (reason, fact) => textFailure(failureCodes[reason], fact),
};

/** A text result: stored under `text-operations/`, checked against the source text it quotes. */
export function textResultKind(source: TextSource): ResultKind<TextInput, TextOutput, TextRecord> {
  return {
    ...textRecordCodec,
    keys: {
      prefix: textKeys.prefix,
      journal: textKeys.journal,
      artifactId: (input, file) => `text-${file}-${hashText(input.operationId)}`,
    },
    limits: {
      resultBytes: textLimits.resultBytes,
      completionBytes: textLimits.completionBytes,
      sourceBytes: textLimits.sourceBytes,
    },
    parseInput: parseTextTask,
    parseOutput: (input, raw) => {
      const output = TextOutputSchema.parse(raw);
      if (!isOwnOutput(input, output)) {
        throw textFailure("TEXT.RESULT_INTEGRITY");
      }
      return output;
    },
    manifest: textManifest,
    evidence: async (input, signal) => {
      const resolved = await source.resolve(input, signal);
      return {
        refs: resolved.refs,
        check: (output, fact) =>
          assertOutputMatchesSource(input, output, { text: resolved.text, fact }),
      };
    },
  };
}

function textManifest(input: TextInput, result: ArtifactRef) {
  return {
    ...textIdentity(input),
    resultKey: result.objectKey,
    resultSha256: result.sha256,
    resultByteSize: result.byteSize,
    complete: true,
  };
}
