import { recordRecovery } from "@crawl-automation/platform";
import { sha256 } from "@crawl-automation/platform";
import {
  type LabelProductJoin,
  type PackagingFacts,
  type ProductImageOutcome,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
import { encodeJson } from "../results/result-record.js";
import { assemblyFailure } from "./assembly-errors.js";
import {
  ASSEMBLY_LIMIT,
  assemblyCode,
  assertSameBytes,
  canonicalJoin,
  claimHandoff,
  keepLocally,
  labelAssemblyKey,
} from "./assembly-files.js";
import { recordAssemblyReview, type AssemblyStores } from "./assembly-review.js";
import { sourceReviewFailure, type ReviewedImageReader } from "./source-review.js";
import { mergeLabelProduct, type MergeFailure, type VerifiedLabelSource } from "./label-merge.js";

type Source = LabelProductJoin["manifest"]["sources"][number];
type State = LabelProductJoin["states"][number];

export interface LabelAssemblyDeps extends AssemblyStores {
  readReviewedImage?: ReviewedImageReader;
  /** Re-verifies a registered source's original evidence and returns its answer. */
  readSource(source: Source, signal: AbortSignal): Promise<VerifiedLabelSource>;
  readPackaging?(
    manifest: LabelProductJoin["manifest"],
    signal: AbortSignal,
  ): Promise<PackagingFacts>;
  visionFingerprint: (task: VisionTask) => string;
}

export interface AssemblyOutput {
  input: LabelProductJoin;
  result: ReturnType<typeof mergeLabelProduct>;
}

/** Assembles one product's label once every source has finished; publication is separate from collection. */
export class LabelAssembly {
  constructor(readonly deps: LabelAssemblyDeps) {}

  /** Read-only: the published assembly of a ready product, recomputed and compared byte for byte. */
  async inspectReady(raw: unknown, key: string, signal: AbortSignal) {
    const input = canonicalJoin(raw);
    const output = await this.compute(input, signal);
    if (key !== labelAssemblyKey(input) || output.result.status !== "ready") {
      throw assemblyFailure("LABEL_PRODUCT.NOT_READY");
    }
    const bytes = await this.deps.remote.read(key, ASSEMBLY_LIMIT, signal);
    assertSameBytes(bytes, encodeJson(output));
    return { key, bytes: bytes ?? new Uint8Array(), output };
  }

  async run(raw: unknown, signal: AbortSignal): Promise<ProductImageOutcome> {
    const input = canonicalJoin(raw);
    const key = labelAssemblyKey(input);
    let output: AssemblyOutput | null = null;
    try {
      output = await this.compute(input, signal);
      await this.publish(input, { key, bytes: encodeJson(output) }, signal);
      signal.throwIfAborted();
    } catch (error) {
      recordRecovery(error, { operation: "label-assembly" });
      signal.throwIfAborted();
      const codes = [...new Set([...(output?.result.codes ?? []), assemblyCode(error)])];
      return recordAssemblyReview(this.deps, {
        input,
        codes,
        key,
        stage: "assembly",
        candidate: output,
      });
    }
    if (output.result.status === "ready") {
      return { status: "ready", evidenceKey: key };
    }
    const { codes } = output.result;
    return recordAssemblyReview(this.deps, {
      input,
      codes,
      key,
      stage: "assembly",
      candidate: output,
    });
  }

  /** Published once: kept locally, claimed in R2, written, read back. An unfinished earlier attempt is not retried. */
  private async publish(
    input: LabelProductJoin,
    file: { key: string; bytes: Uint8Array },
    signal: AbortSignal,
  ) {
    const { local, remote } = this.deps;
    if (file.bytes.length > ASSEMBLY_LIMIT) {
      throw assemblyFailure("LABEL_PRODUCT.OUTPUT_LIMIT");
    }
    const prior = await remote.read(file.key, ASSEMBLY_LIMIT, signal);
    if (prior) {
      assertSameBytes(prior, file.bytes);
      return;
    }
    const intent = `v3/label-products/${input.manifest.operationId}/assembly-intent.json`;
    if (
      (await remote.read(intent, 65_536, signal)) ||
      (await local.read(file.key, ASSEMBLY_LIMIT, signal))
    ) {
      throw assemblyFailure("LABEL_PRODUCT.HANDOFF_PENDING");
    }
    await keepLocally(local, file, signal);
    await claimHandoff(remote, { key: intent, hash: sha256(file.bytes) }, signal);
    try {
      await remote.create(file.key, file.bytes, "application/json", signal);
    } catch (error) {
      recordRecovery(error, { operation: "assembly/label-assembly" });
      // The read-back below decides; never a second write.
    }
    assertSameBytes(await remote.read(file.key, ASSEMBLY_LIMIT, signal), file.bytes);
  }

  private async compute(input: LabelProductJoin, signal: AbortSignal): Promise<AssemblyOutput> {
    const states = new Map(input.states.map((state) => [state.id, state]));
    const known = input.states.every((state) =>
      input.manifest.sources.some((source) => source.id === state.id),
    );
    if (states.size !== input.states.length || !known) {
      throw assemblyFailure("LABEL_PRODUCT.IDENTITY_CONFLICT");
    }
    if (states.size !== input.manifest.sources.length) {
      throw assemblyFailure("LABEL_PRODUCT.BARRIER_INCOMPLETE");
    }
    const entries: VerifiedLabelSource[] = [];
    const failures: MergeFailure[] = [];
    for (const source of input.manifest.sources) {
      signal.throwIfAborted();
      await this.collectSource(source, {
        input,
        state: states.get(source.id),
        entries,
        failures,
        signal,
      });
    }
    let packaging: PackagingFacts | undefined;
    if (input.manifest.admission) {
      if (!this.deps.readPackaging) {
        throw assemblyFailure("LABEL_PRODUCT.PACKAGING_UNVERIFIED");
      }
      packaging = await this.deps.readPackaging(input.manifest, signal);
    }
    return { input, result: mergeLabelProduct(input.manifest, { entries, failures }, packaging) };
  }

  private async collectSource(
    source: Source,
    at: {
      input: LabelProductJoin;
      state: State | undefined;
      entries: VerifiedLabelSource[];
      failures: MergeFailure[];
      signal: AbortSignal;
    },
  ): Promise<void> {
    const { state, signal } = at;
    if (!state || state.status === "rejected" || state.status === "not_matched") {
      throw assemblyFailure("LABEL_PRODUCT.RECEIPT_INVALID");
    }
    if (state.status === "review") {
      const reviewed = {
        input: at.input,
        reviewId: state.reviewId,
        readImage: this.deps.readReviewedImage,
        signal,
      };
      at.failures.push(await sourceReviewFailure(this.deps, source, reviewed));
      return;
    }
    try {
      const entry = await this.deps.readSource(source, signal);
      if (entry.id !== source.id || entry.kind !== source.kind) {
        throw assemblyFailure("LABEL_PRODUCT.IDENTITY_CONFLICT");
      }
      at.entries.push(entry);
    } catch (error) {
      recordRecovery(error, { operation: "label-assembly" });
      signal.throwIfAborted();
      const code = assemblyCode(error);
      if (code === "LABEL_PRODUCT.IDENTITY_CONFLICT") {
        throw error;
      }
      at.failures.push({ id: source.id, code });
    }
  }
}
