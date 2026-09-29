import type { AppError } from "@crawl-automation/platform";
import type { ArtifactRef } from "@crawl-automation/v3-contracts";
import type { ExecutionFact } from "../step/step-failure.js";

/** Why a stored result cannot be used. Each kind maps a reason to the code its Reviews already carry. */
export type ResultFailureReason =
  | "conflict"
  | "integrity"
  | "incomplete"
  | "notYetDurable"
  | "unknown"
  | "registeredNotDurable"
  | "sourceNotDurable"
  | "registryUnavailable"
  | "outputLimit";

/** The task fields every processing result is keyed and owned by. */
export interface ProcessingInput {
  requestId: string;
  operationId: string;
  inputFingerprint: string;
  observationId: string;
  sourceId: string;
  listingId: string;
  variantId: string | null;
  module: string;
  implementationVersion: string;
}

/** A result's ledger entry: its task, where it was stored, and its two files. */
export interface StoredRecord<TInput> {
  schemaVersion: 1;
  storageId: string;
  input: TInput;
  result: ArtifactRef;
  completion: ArtifactRef;
}

/** The evidence a result was computed from: the artifacts it depends on and a check of an output against them. */
export interface ResultEvidence<TOutput> {
  refs: readonly ArtifactRef[];
  check(output: TOutput, fact?: ExecutionFact): void;
}

/** How one kind's ledger records are read and what its failures are called. */
export interface RecordCodec<TRecord> {
  parseRecord(raw: unknown): TRecord;
  fail(reason: ResultFailureReason, fact?: ExecutionFact): AppError;
}

/**
 * What differs between kinds of processing result (text, OCR). The shared result store runs with one of these
 * (Strategy); everything else about storing a result is written once.
 */
export interface ResultKind<
  TInput extends ProcessingInput,
  TOutput,
  TRecord extends StoredRecord<TInput>,
> extends RecordCodec<TRecord> {
  keys: {
    /** `<prefix>/result.json` and `<prefix>/completion.json`, locally and in R2. */
    prefix(input: TInput): string;
    /** This worker's local journal entry. */
    journal(input: TInput): string;
    artifactId(input: TInput, file: "result" | "completion"): string;
  };
  limits: { resultBytes: number; completionBytes: number; sourceBytes: number };
  parseInput(raw: unknown): TInput;
  /** The stored output, checked to belong to exactly this task. */
  parseOutput(input: TInput, raw: unknown): TOutput;
  manifest(input: TInput, result: ArtifactRef): unknown;
  evidence(input: TInput, signal: AbortSignal): Promise<ResultEvidence<TOutput>>;
}

/** What is known about a task's result: computed here, durable in R2, registered in the ledger. */
export interface ResultFacts<TRecord> {
  computedLocal: boolean;
  artifactDurable: boolean;
  resultRegistered: boolean;
  record: TRecord | null;
}

/** The result ledger (`processing_result`). A cloud worker has none. */
export interface ResultRegistry<TRecord> {
  read(operationId: string): Promise<TRecord | null>;
  register(record: TRecord): Promise<void>;
}

export const noResult = {
  computedLocal: false,
  artifactDurable: false,
  resultRegistered: false,
  record: null,
} as const;
