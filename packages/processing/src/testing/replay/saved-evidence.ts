import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ReviewRecordSchema,
  TextInputSchema,
  type TextInput,
} from "@crawl-automation/v3-contracts";

const EvidenceSchema = z.object({
  reviewId: z.string(),
  documents: z.record(z.string(), z.string()).default({}),
  evidence: z.array(z.object({ key: z.string(), status: z.string(), content: z.unknown() })),
});
const QueueSchema = z.object({
  runId: z.string(),
  state: z.string(),
  reason: z.string().nullable(),
  listingId: z.string(),
});
const IntentSchema = z.object({ input: TextInputSchema });
const DocumentSchema = z.object({ text: z.string() });

function readLines(directory: string, file: string): unknown[] {
  return readFileSync(join(directory, file), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

/** Nothing is loaded unless the opt-in test supplies the external scratchpad directory. */
export function savedEvidence(directory: string) {
  const records = readLines(directory, "review-records.jsonl").map(
    (value) => z.object({ record: ReviewRecordSchema }).parse(value).record,
  );
  const evidence = readLines(directory, "review-evidence.jsonl").map((value) =>
    EvidenceSchema.parse(value),
  );
  const queue = readLines(directory, "queue-items.jsonl").map((value) => QueueSchema.parse(value));
  const documents = new Map<string, string>();
  for (const entry of evidence) {
    for (const [hash, bytes] of Object.entries(entry.documents)) {
      assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
      documents.set(hash, bytes);
    }
  }
  return {
    records: new Map(records.map((record) => [record.reviewId, record])),
    evidence: new Map(evidence.map((entry) => [entry.reviewId, entry])),
    documents,
    queue,
  };
}
export type SavedEvidence = ReturnType<typeof savedEvidence>;

export function textInput(data: SavedEvidence, reviewId: string): TextInput | null {
  for (const entry of data.evidence.get(reviewId)?.evidence ?? []) {
    const parsed = IntentSchema.safeParse(entry.content);
    if (entry.status === "present" && parsed.success) {
      return parsed.data.input;
    }
  }
  return null;
}

export function documentText(data: SavedEvidence, input: TextInput): string {
  assert.equal(input.source.kind, "prepared");
  if (input.source.kind !== "prepared") {
    throw new Error("Replay needs prepared text");
  }
  const bytes = data.documents.get(input.source.document.sha256);
  assert.ok(bytes, "Missing saved input document");
  assert.equal(Buffer.byteLength(bytes), input.source.document.byteSize);
  return DocumentSchema.parse(JSON.parse(bytes)).text;
}
