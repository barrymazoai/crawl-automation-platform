import { isDeepStrictEqual } from "node:util";
import type { RetainedPublication } from "@crawl-automation/platform";
import type { ArtifactRef, SavedEvidenceSource } from "@crawl-automation/v3-contracts";
import { decodeJson, encodeJson } from "../results/result-record.js";
import { labelFailure } from "./label-errors.js";
import {
  LabelManifestResultSchema,
  LabelPlanInputSchema,
  LabelSourceRequestSchema,
  LabelSourceResultSchema,
  labelKeys,
  type LabelManifestResult,
  type LabelPlanInput,
  type LabelSourceResult,
  type ProductPlanReader,
  type SavedManifest,
  type SourceResolver,
} from "./label-plan-model.js";
import { labelSourceTask, type LabelCoreReader } from "./label-source-task.js";

const MANIFEST_LIMIT = 2 * 1024 * 1024;

export interface LabelPlansDeps {
  plans: ProductPlanReader;
  publication: RetainedPublication;
  resolve: SourceResolver;
  core?: LabelCoreReader;
}

export interface LoadedPlan {
  input: LabelPlanInput;
  manifest: SavedManifest;
  /** Image sources in the order to try them (image-first policy only). */
  imageOrder?: string[];
}

/** Filename hints choose an attempt order only; verified extraction decides whether an image holds the label. */
function imageRank(url: string): number {
  if (/supplement.?facts|nutrition.?facts|flat.?label|label.?flat/i.test(url)) {
    return 0;
  }
  if (/label|facts/i.test(url)) {
    return 1;
  }
  return /front/i.test(url) ? 3 : 2;
}

/**
 * Label plans for every channel: turns a product's prepared sources into label-protocol tasks and the label
 * manifest. It only reads prepared evidence; it never downloads, runs OCR or calls a model.
 */
export class LabelPlans {
  constructor(private readonly deps: LabelPlansDeps) {}

  async load(raw: unknown, signal: AbortSignal): Promise<LoadedPlan> {
    const input = LabelPlanInputSchema.parse(raw);
    const plan = await this.deps.plans.inspect(input.plan, signal);
    if (!plan) {
      throw labelFailure("CHANNEL.LABEL_SOURCE_UNVERIFIED");
    }
    const { manifest } = plan;
    if (
      manifest.operationId !== input.plan.operationId ||
      !isDeepStrictEqual(manifest.observation, input.owner)
    ) {
      throw labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");
    }
    if (input.evidencePolicy !== "label-image-first/5") {
      return { input, manifest };
    }
    const urls = new Map((plan.files ?? []).map((file) => [file.resourceId, file.url]));
    const rank = (source: SavedEvidenceSource) =>
      imageRank(
        source.kind === "file-image" ? (urls.get(source.plan.acquire.resourceId) ?? "") : "",
      );
    const images = manifest.sources.filter((source) => source.kind === "file-image");
    const imageOrder = images
      .sort((left, right) => rank(left) - rank(right))
      .map((source) => source.id);
    return { input, manifest, imageOrder };
  }

  /** One source's label task (or "not matched"), published as evidence. */
  async source(raw: unknown, signal: AbortSignal): Promise<LabelSourceResult> {
    const request = LabelSourceRequestSchema.parse(raw);
    const { manifest } = await this.load(request.input, signal);
    const source = manifest.sources.find((entry) => entry.id === request.sourceId);
    if (!source || (source.kind !== "page" && source.kind !== "file-image")) {
      throw labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");
    }
    const resolution = await this.deps.resolve(source, signal);
    if (resolution.status === "review") {
      throw labelFailure("CHANNEL.LABEL_PREPARATION_UNVERIFIED");
    }
    let result: LabelSourceResult;
    if (resolution.status === "not_matched") {
      if (source.kind !== "file-image") {
        throw labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");
      }
      result = { status: "not_matched", input: request };
    } else {
      const prepared = { source, resolved: resolution.source };
      result = await labelSourceTask(request, prepared, { reader: this.deps.core, signal });
    }
    const parsed = LabelSourceResultSchema.parse(result);
    await this.publish(labelKeys.source(request.input, source.id), parsed, signal);
    return parsed;
  }

  /** The label manifest over every source (not for image-first tasks, which select first). */
  async manifest(raw: unknown, signal: AbortSignal): Promise<LabelManifestResult> {
    const { input, manifest } = await this.load(raw, signal);
    if (input.evidencePolicy === "label-image-first/5") {
      throw labelFailure("CHANNEL.LABEL_SELECTION_REQUIRED");
    }
    const sources = [];
    const skipped: string[] = [];
    for (const source of manifest.sources) {
      const result = await this.source({ input, sourceId: source.id }, signal);
      if (result.status === "prepared") {
        sources.push(result.source);
      } else {
        skipped.push(source.id);
      }
    }
    const documents = input.admission ? await this.fullDocuments(manifest, signal) : [];
    return this.publishManifest({ input, sources, skipped, documents }, signal);
  }

  /** Builds, publishes and reads back the label manifest. No source holding a label is a failure of its own. */
  async publishManifest(
    parts: {
      input: LabelPlanInput;
      sources: unknown[];
      skipped: string[];
      documents: ArtifactRef[];
    },
    signal: AbortSignal,
  ): Promise<LabelManifestResult> {
    const { input, sources, skipped, documents } = parts;
    if (!sources.length) {
      throw labelFailure("CHANNEL.LABEL_NO_SOURCE");
    }
    const admission = { policy: input.admission, comparison: "label-typography/2", documents };
    const result = LabelManifestResultSchema.parse({
      input,
      manifest: {
        operationId: input.operationId,
        observation: input.owner,
        ...(input.evidencePolicy ? { evidencePolicy: input.evidencePolicy } : {}),
        sources,
        ...(input.admission ? { admission } : {}),
      },
      skipped,
    });
    const key = labelKeys.manifest(input);
    await this.publish(key, result, signal);
    const saved = await this.deps.publication.remote.read(key, MANIFEST_LIMIT, signal);
    if (!saved || !isDeepStrictEqual(decodeJson(saved), result)) {
      throw labelFailure("CHANNEL.LABEL_HANDOFF_UNVERIFIED");
    }
    return result;
  }

  publish(key: string, value: unknown, signal: AbortSignal): Promise<void> {
    return this.deps.publication.publish(key, encodeJson(value), "application/json", signal);
  }

  /** The full prepared page documents, for packaging admission. */
  private async fullDocuments(
    manifest: SavedManifest,
    signal: AbortSignal,
  ): Promise<ArtifactRef[]> {
    const documents: ArtifactRef[] = [];
    for (const source of manifest.sources.filter((entry) => entry.kind === "page")) {
      const full = await this.deps.resolve(source, signal);
      const prepared =
        full.status === "resolved" && full.source.kind === "text" ? full.source.task.source : null;
      if (prepared?.kind !== "prepared") {
        throw labelFailure("CHANNEL.LABEL_SOURCE_UNVERIFIED");
      }
      documents.push(prepared.document);
    }
    return documents;
  }
}
