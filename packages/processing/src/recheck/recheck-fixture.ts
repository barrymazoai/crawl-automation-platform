import { vi } from "vitest";
import { ArtifactResolver, sha256 } from "@crawl-automation/platform";
import {
  LabelProductJoinSchema,
  TextInputSchema,
  textFingerprint,
  observationIdentity,
  type TextInput,
} from "@crawl-automation/v3-contracts";
import { pageSetup } from "../testing/page-fixture.js";
import { simpleLabel } from "../testing/simple-label.js";
import { defined } from "../testing/defined.js";
import { encodeJson, hashString } from "../results/result-record.js";
import { TextEvidence } from "../text/evidence/text-evidence.js";
import { textKeys } from "../text/results/text-record.js";
import { buildStepReview } from "../step/step-review.js";
import { noResult } from "../results/result-kind.js";
import { SavedLabelRecheck } from "./assembly-recheck.js";

export const signal = () => new AbortController().signal;

/** Synthetic label and saved answer with a formerly rejected FDA metadata exclusion. No data files. */
export async function recheckFixture() {
  const { setup, task, wire } = await preparedFixture();
  const observation = observationIdentity(task);
  const review = savedTextReview(task, wire);
  setup.records.set(review.reviewId, review);
  setup.remote.data.set(textKeys.intent(task), encodeJson({ input: task }));
  const join = LabelProductJoinSchema.parse({
    manifest: {
      operationId: "product-op",
      observation,
      evidencePolicy: "label-image-first/5",
      sources: [{ id: "text", kind: "text", required: true, task }],
    },
    states: [{ id: "text", status: "review", reviewId: review.reviewId }],
  });
  const product = productReview(join);
  setup.records.set(product.reviewId, product);
  const deps = fixtureDeps(setup);
  return {
    ...setup,
    task,
    join,
    product,
    sourceReview: review,
    deps,
    recheck: new SavedLabelRecheck(deps),
  };
}

async function preparedFixture() {
  const note = "Percent Daily Values are based on a 2,000 calorie diet.";
  const { lines, wire } = simpleLabel({ note });
  wire.exclusions = [
    { quote: { text: defined(lines[0]), fromLine: 1, toLine: 1 }, reason: "heading" },
    { quote: { text: defined(lines[5]), fromLine: 6, toLine: 6 }, reason: "footnote" },
    { quote: { text: note, fromLine: 8, toLine: 8 }, reason: "metadata" },
  ];
  const setup = pageSetup(`<html><body><pre>${lines.join("\n")}</pre></body></html>`);
  const page = await setup.preparation.run(setup.input, signal());
  if (page.status !== "durable") {
    throw new Error("fixture preparation failed");
  }
  const unsigned = {
    ...observationIdentity(setup.input),
    ...setup.plan.text,
    operationId: "text-op",
    implementationVersion: "codex-text/3",
    policyVersion: "label-text/4",
    resultSchemaVersion: 3 as const,
    source: { kind: "prepared" as const, document: page.record.document },
    range: { start: 0, end: page.record.textLength },
  };
  const task = TextInputSchema.parse({
    ...unsigned,
    inputFingerprint: textFingerprint(unsigned, hashString),
  });
  return { setup, task, wire };
}

function savedTextReview(task: TextInput, wire: unknown) {
  return buildStepReview({
    reviewId: "saved-text-review",
    task,
    observation: observationIdentity(task),
    stage: "codex.text",
    category: "PROCESSING",
    code: "TEXT.LABEL_COVERAGE_UNCERTAIN",
    fact: "executed",
    evidenceKey: textKeys.intent(task),
    blockedBy: null,
    error: { name: "old-rule", details: {} },
    inspection: { kind: "none" },
    candidate: { schema: "text-raw-response/1", value: { rawResponse: JSON.stringify(wire) } },
  });
}

export function productReview(join: ReturnType<typeof LabelProductJoinSchema.parse>) {
  return buildStepReview({
    reviewId: "product-review",
    task: {
      ...join.manifest.observation,
      operationId: join.manifest.operationId,
      inputFingerprint: sha256(encodeJson(join)),
    },
    observation: join.manifest.observation,
    stage: "product.label.assembly",
    category: "VALIDATION",
    code: "VALIDATION.FORMULA_MISSING",
    fact: "unknown",
    evidenceKey: "v3/product/assembly.json",
    blockedBy: null,
    error: { name: "old-rules", details: { input: join } },
    candidate: { schema: "label-product-assembly/1", value: { input: join } },
    inspection: { kind: "none" },
  });
}

function fixtureDeps(setup: ReturnType<typeof pageSetup>) {
  const artifacts = new ArtifactResolver(
    { read: async () => null, retain: async () => undefined },
    setup.remote,
  );
  const text = new TextEvidence({
    artifacts,
    ocr: { inspect: async () => noResult },
    labelCores: {},
  });
  return {
    objects: setup.remote,
    reviews: setup.reviews,
    storageId: "test/1",
    labelCores: {},
    text,
    textRecords: { read: vi.fn(async () => null) },
    imageRecords: { read: vi.fn(async () => null) },
    verifyOcr: vi.fn(async () => undefined),
  };
}
