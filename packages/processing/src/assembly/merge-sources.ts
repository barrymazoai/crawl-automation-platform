import { isDeepStrictEqual } from "node:util";
import {
  LabelImageCandidateSchema,
  LabelProductManifestSchema,
  PackagingFactsSchema,
  TextCandidateV3Schema,
  TextRecordSchema,
  VisionRecordSchema,
  LabelProductProvenanceSchema,
  isCompleteLabelImage,
  isCompleteLabelText,
  assertTextQuotes,
  type LabelProductManifest,
  type PackagingFacts,
} from "@crawl-automation/v3-contracts";
import { assemblyFailure } from "./assembly-errors.js";
import {
  byText,
  words,
  type MergeFailure,
  type MergeState,
  type Provenance,
  type VerifiedLabelSource,
} from "./merge-state.js";

const conflict = () => assemblyFailure("LABEL_PRODUCT.IDENTITY_CONFLICT");

/** The merge's starting state; packaging evidence is present exactly when the manifest asks for admission. */
export function beginMerge(
  raw: LabelProductManifest,
  rawPackaging: PackagingFacts | undefined,
): MergeState {
  const manifest = LabelProductManifestSchema.parse(raw);
  const state: MergeState = {
    manifest,
    sources: new Map(manifest.sources.map((source) => [source.id, source])),
    codes: new Set(),
    warnings: [],
    counts: new Set(),
    packaging: undefined,
    formula: null,
    otherIngredients: null,
    formulaShape: null,
    otherShape: null,
  };
  if (!!manifest.admission !== !!rawPackaging) {
    throw assemblyFailure("LABEL_PRODUCT.PACKAGING_UNVERIFIED");
  }
  if (rawPackaging) {
    const packaging = PackagingFactsSchema.parse(rawPackaging);
    if (!isDeepStrictEqual(packaging.observation, manifest.observation)) {
      throw conflict();
    }
    packaging.warnings.forEach((code) => state.warnings.push({ id: manifest.operationId, code }));
    packaging.servingsPerContainer.claims.forEach((claim) => state.counts.add(words(claim.value)));
    state.packaging = packaging;
  }
  return state;
}

/**
 * Every source is accounted for once, and every answer belongs to its source's task; every text quote, exclusions
 * included, is checked against the full prepared document. Priority can never bypass any of this.
 */
export function verifiedProvenance(
  state: MergeState,
  entries: VerifiedLabelSource[],
  failures: MergeFailure[],
): { provenance: Provenance[]; seen: Set<string> } {
  const seen = new Set<string>();
  const provenance: Provenance[] = [];
  for (const failure of failures) {
    if (!state.sources.has(failure.id) || seen.has(failure.id)) {
      throw conflict();
    }
    seen.add(failure.id);
  }
  for (const entry of [...entries].sort((left, right) => byText(left.id, right.id))) {
    const source = state.sources.get(entry.id);
    if (!source || source.kind !== entry.kind || seen.has(entry.id)) {
      throw conflict();
    }
    seen.add(entry.id);
    provenance.push(verifiedEntry(entry, source));
  }
  if (needsReviewedSections(state, provenance)) {
    for (const failure of failures.filter((failure) => failure.reviewed)) {
      provenance.push(verifiedReview(state, failure));
    }
  }
  return { provenance: provenance.sort((left, right) => byText(left.id, right.id)), seen };
}

function needsReviewedSections(state: MergeState, provenance: Provenance[]) {
  return (
    state.manifest.evidencePolicy === "label-image-first/6" &&
    !provenance.some(isCompleteLabelImage) &&
    !provenance.some(isCompleteLabelText)
  );
}

function verifiedReview(state: MergeState, failure: MergeFailure): Provenance {
  const entry = LabelProductProvenanceSchema.parse(failure.reviewed);
  const source = state.sources.get(failure.id);
  if (
    entry.kind !== "image" ||
    source?.kind !== "image" ||
    entry.id !== failure.id ||
    failure.verifiedExecuted !== true ||
    entry.record.codec !== "vision-reviewed/1" ||
    !isDeepStrictEqual(entry.candidate, failure.candidate) ||
    !isDeepStrictEqual(
      { input: entry.record.input, configFingerprint: entry.record.configFingerprint },
      source.task,
    )
  ) {
    throw conflict();
  }
  if (!reviewCandidateMatches(entry)) {
    throw conflict();
  }
  return entry;
}

function reviewCandidateMatches(entry: Extract<Provenance, { kind: "image" }>) {
  return (
    entry.record.codec === "vision-reviewed/1" &&
    isDeepStrictEqual(entry.candidate, entry.record.review.candidate?.value)
  );
}

function verifiedEntry(
  entry: VerifiedLabelSource,
  source: LabelProductManifest["sources"][number],
): Provenance {
  if (entry.kind === "text") {
    if (!isDeepStrictEqual(TextRecordSchema.parse(entry.record).input, source.task)) {
      throw conflict();
    }
    const candidate = TextCandidateV3Schema.parse(entry.candidate);
    const { range } = entry.record.input;
    if (range.start !== 0 || range.end !== entry.fullText.length) {
      throw assemblyFailure("LABEL_PRODUCT.TEXT_SCOPE_UNVERIFIED");
    }
    assertTextQuotes(candidate, entry.record.input, entry.fullText);
    return { id: entry.id, kind: "text", record: entry.record, candidate };
  }
  const task = {
    input: VisionRecordSchema.parse(entry.record).input,
    configFingerprint: entry.record.configFingerprint,
  };
  if (!isDeepStrictEqual(task, source.task)) {
    throw conflict();
  }
  return {
    id: entry.id,
    kind: "image",
    record: entry.record,
    candidate: LabelImageCandidateSchema.parse(entry.candidate),
  };
}
