import { sha256 } from "@crawl-automation/platform";
import {
  LabelCollectedProductSchema,
  LabelCollectionInputSchema,
  type LabelCollectedProduct,
  type LabelProductJoin,
  type ProductWorkflowOutcome,
} from "@crawl-automation/v3-contracts";
import { encodeJson } from "../results/result-record.js";
import { assemblyFailure } from "./assembly-errors.js";
import {
  ASSEMBLY_LIMIT,
  assemblyCode,
  canonicalJoin,
  claimHandoff,
  keepLocally,
} from "./assembly-files.js";
import {
  recordAssemblyReview,
  type AssemblyStores,
  type ExistingCollection,
} from "./assembly-review.js";
import type { LabelAssembly } from "./label-assembly.js";

/** The hash stored beside a collected product: of its schema-checked JSON. */
export const labelCollectedHash = (raw: unknown) =>
  sha256(encodeJson(LabelCollectedProductSchema.parse(raw)));

/** The collected-product ledger (`collected_product`): one record per operation, written once. */
export interface LabelCollectedRegistry {
  read(operationId: string): Promise<LabelCollectedProduct | null>;
  append(record: LabelCollectedProduct): Promise<void>;
  readObservation?(observationId: string): Promise<LabelCollectedProduct | null>;
}

export interface LabelCollectionDeps extends AssemblyStores {
  assembly: Pick<LabelAssembly, "inspectReady">;
  registry: LabelCollectedRegistry;
}

type Ready = Awaited<ReturnType<LabelAssembly["inspectReady"]>>;

/** Collects a ready product into the ledger once; any failure becomes a Review. The first collected version is kept. */
export class LabelCollection {
  constructor(private readonly deps: LabelCollectionDeps) {}

  async run(raw: unknown, signal: AbortSignal): Promise<ProductWorkflowOutcome> {
    const parsed = LabelCollectionInputSchema.parse(raw);
    const input = canonicalJoin(parsed.join);
    const key = parsed.evidenceKey;
    const attempt: { candidate: LabelCollectedProduct | null; existing?: ExistingCollection } = {
      candidate: null,
    };
    try {
      signal.throwIfAborted();
      const evidence = await this.deps.assembly.inspectReady(input, key, signal);
      attempt.candidate = collectedCandidate(input, { key, evidence });
      const hash = await this.register(attempt, signal);
      await this.deps.assembly.inspectReady(input, key, signal);
      signal.throwIfAborted();
      const { operationId, observation } = attempt.candidate;
      return {
        status: "collected",
        operationId,
        observationId: observation.observationId,
        recordHash: hash,
        evidenceKey: key,
      };
    } catch (error) {
      signal.throwIfAborted();
      const review = { input, codes: [assemblyCode(error)], key, stage: "collect" as const };
      const result = await recordAssemblyReview(this.deps, {
        ...review,
        candidate: attempt.candidate,
        existingCollection: attempt.existing,
      });
      if (result.status !== "review") {
        throw assemblyFailure("LABEL_PRODUCT.REVIEW_UNVERIFIED");
      }
      return result;
    }
  }

  /** Written once behind a local copy and a shared claim; a lost acknowledgement is only read back. */
  private async register(
    attempt: { candidate: LabelCollectedProduct | null; existing?: ExistingCollection },
    signal: AbortSignal,
  ): Promise<string> {
    const candidate = attempt.candidate as LabelCollectedProduct;
    const hash = labelCollectedHash(candidate);
    const prior = await this.deps.registry.read(candidate.operationId);
    if (prior && labelCollectedHash(prior) !== hash) {
      throw assemblyFailure("LABEL_COLLECTION.CONFLICT");
    }
    if (!prior) {
      await this.assertObservationFree(attempt);
      await this.append(candidate, { hash, signal });
    }
    const saved = await this.deps.registry.read(candidate.operationId);
    if (!saved) {
      await this.assertObservationFree(attempt);
      throw assemblyFailure("LABEL_COLLECTION.REGISTRATION_UNKNOWN");
    }
    if (labelCollectedHash(saved) !== hash) {
      throw assemblyFailure("LABEL_COLLECTION.CONFLICT");
    }
    return hash;
  }

  private async append(
    candidate: LabelCollectedProduct,
    at: { hash: string; signal: AbortSignal },
  ) {
    const { local, remote } = this.deps;
    const localKey = `label-collection/${candidate.operationId}.json`;
    const intent = `v3/label-products/${candidate.operationId}/collection-intent.json`;
    if (
      (await remote.read(intent, 65_536, at.signal)) ||
      (await local.read(localKey, ASSEMBLY_LIMIT, at.signal))
    ) {
      throw assemblyFailure("LABEL_PRODUCT.HANDOFF_PENDING");
    }
    await keepLocally(local, { key: localKey, bytes: encodeJson(candidate) }, at.signal);
    await claimHandoff(remote, { key: intent, hash: at.hash }, at.signal);
    at.signal.throwIfAborted();
    try {
      await this.deps.registry.append(candidate);
    } catch {
      // Settled by the read-back; the insert is never repeated.
    }
  }

  /** An observation already collected under another operation keeps its first version. */
  private async assertObservationFree(attempt: {
    candidate: LabelCollectedProduct | null;
    existing?: ExistingCollection;
  }) {
    const { candidate } = attempt;
    if (!candidate || !this.deps.registry.readObservation) {
      return;
    }
    const existing = await this.deps.registry.readObservation(candidate.observation.observationId);
    if (existing && existing.operationId !== candidate.operationId) {
      attempt.existing = {
        operationId: existing.operationId,
        observationId: existing.observation.observationId,
        recordHash: labelCollectedHash(existing),
      };
      throw assemblyFailure("LABEL_COLLECTION.OBSERVATION_ALREADY_COLLECTED");
    }
  }
}

/** The collected product: the assembly's result, pointing at the assembly file it came from. */
function collectedCandidate(
  input: LabelProductJoin,
  at: { key: string; evidence: Ready },
): LabelCollectedProduct {
  const result = at.evidence.output.result;
  const version = input.manifest.admission
    ? {
        schemaVersion: 4,
        codec: "collected-product/4",
        admissionPolicy: result.admissionPolicy,
        comparisonPolicy: result.comparisonPolicy,
        packaging: result.packaging,
      }
    : { schemaVersion: 3, codec: "collected-product/3" };
  return LabelCollectedProductSchema.parse({
    ...version,
    operationId: input.manifest.operationId,
    observation: input.manifest.observation,
    assembly: {
      objectKey: at.key,
      sha256: sha256(at.evidence.bytes),
      byteSize: at.evidence.bytes.length,
    },
    ...(result.evidencePolicy ? { evidencePolicy: result.evidencePolicy } : {}),
    formula: result.formula,
    otherIngredients: result.otherIngredients,
    ingredients: result.ingredients,
    warnings: result.warnings,
    provenance: result.provenance,
  });
}
