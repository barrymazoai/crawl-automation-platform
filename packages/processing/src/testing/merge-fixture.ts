import { expect } from "vitest";
import { type LabelImageCandidate, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { mergeLabelProduct, type VerifiedLabelSource } from "../assembly/label-merge.js";
import { assemblySetup, labelCandidate, textEntry } from "./assembly-fixture.js";
import { defined } from "./defined.js";

export const signal = () => new AbortController().signal;

/** Image sources plus one complete text source, all verified; image-first policy /1. */
export async function mergeSetup(images = [labelCandidate()], text = labelCandidate()) {
  const setup = assemblySetup(images);
  const entry = textEntry(text);
  const readImage = defined(setup.deps.readSource.getMockImplementation());
  const read = async (source: { id: string }): Promise<VerifiedLabelSource> =>
    source.id === entry.id ? structuredClone(entry) : readImage(source);
  setup.deps.readSource.mockImplementation(read);
  setup.join.manifest.sources.push({
    id: entry.id,
    kind: "text",
    required: true,
    task: entry.record.input,
  });
  setup.join.states.push({ id: entry.id, status: "registered" });
  setup.join.manifest.evidencePolicy = "label-image-first/1";
  const entries = await Promise.all(setup.join.manifest.sources.map((source) => read(source)));
  return { ...setup, entries, text: entry };
}

export type MergeSetup = Awaited<ReturnType<typeof mergeSetup>>;

export const rowsOf = (candidate: LabelImageCandidate) =>
  defined(candidate.formula?.columns[0]).rows;
export const merge = (
  setup: MergeSetup,
  entries = setup.entries,
  failures?: { id: string; code: string; verifiedExecuted?: boolean }[],
) => mergeLabelProduct(setup.join.manifest, failures ? { entries, failures } : { entries });
export const images = (setup: MergeSetup) =>
  setup.entries.filter((entry) => entry.kind === "image");

/** A text label that groups B12 as its own nutrient where the image groups it under a blend. */
export function b12Text(): LabelImageCandidate {
  const candidate = labelCandidate();
  const row = defined(rowsOf(candidate)[17]);
  row.kind = "nutrient";
  row.parentRowIndex = null;
  return candidate;
}

export function reviewOf(
  setup: MergeSetup,
  at: { id: string; code: string; operationId: string; inputFingerprint: string; stage: string },
): ReviewRecord {
  const { observation } = setup.join.manifest;
  return {
    schemaVersion: 1,
    reviewId: at.id,
    occurredAt: "2026-09-10T00:00:00.000Z",
    observation,
    failure: {
      schemaVersion: 1,
      requestId: observation.requestId,
      observationId: observation.observationId,
      operationId: at.operationId,
      inputFingerprint: at.inputFingerprint,
      stage: at.stage,
      category: "PROCESSING",
      code: at.code,
      executionFact: "executed",
      evidenceKey: "text-intents/original.json",
      blockedBy: null,
      automaticRetry: false,
    },
    rawError: { name: "quality", message: at.code, stack: null, details: {} },
    candidate: null,
    inspection: { kind: "none" },
  };
}

export function textReview(setup: MergeSetup, code: string): ReviewRecord {
  const task = setup.text.record.input;
  const review = reviewOf(setup, {
    id: "text-quality-review",
    code,
    operationId: task.operationId,
    inputFingerprint: task.inputFingerprint,
    stage: "codex.text",
  });
  setup.records.set(review.reviewId, review);
  setup.join.states = setup.join.states.map((state) =>
    state.id === "a-text" ? { id: state.id, status: "review", reviewId: review.reviewId } : state,
  );
  return review;
}

export async function collectBoth(setup: MergeSetup) {
  const out = await setup.assembly.run(setup.join, signal());
  expect(out.status).toBe("ready");
  const input = { join: setup.join, evidenceKey: out.evidenceKey };
  expect((await setup.collector.run(input, signal())).status).toBe("collected");
  expect((await setup.cold().collector.run(input, signal())).status).toBe("collected");
  return defined([...setup.collected.values()][0]);
}
