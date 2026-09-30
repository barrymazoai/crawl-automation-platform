import { isDeepStrictEqual } from "node:util";
import { errorCodeOf, type ObjectStore } from "@crawl-automation/platform";
import { sha256, type ArtifactResolver } from "@crawl-automation/platform";
import {
  ArtifactRefSchema,
  LabelCoreInputSchema,
  LabelCoreOutcomeSchema,
  TextDocumentSchema,
  textObservation,
  type ArtifactRef,
  type LabelCoreInput,
  type LabelCoreOutcome,
  type Observation,
} from "@crawl-automation/v3-contracts";
import { decodeJson, encodeJson } from "../results/result-record.js";
import type { LabelCorePolicies, LabelCorePolicy } from "../text/evidence/label-core-policy.js";
import { labelFailure } from "./label-errors.js";

const DOCUMENT_LIMIT = 1_048_576;

export interface LabelCoreStepDeps {
  artifacts: Pick<ArtifactResolver, "resolve">;
  remote: ObjectStore;
  /** The label-core policies the channels supply, by name (e.g. `swanson-label-core/1`). */
  policies: LabelCorePolicies;
}

const decodeUtf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/**
 * Label-core preparation for every channel: reads a prepared page's original source, lets the channel's policy pick
 * out the label facts text, and publishes it as a content-addressed text document. The original page stays as it is.
 */
export class LabelCoreStep {
  constructor(private readonly deps: LabelCoreStepDeps) {}

  /** Prepares and publishes the label-core document. */
  run(raw: unknown, signal: AbortSignal): Promise<LabelCoreOutcome> {
    return this.prepare(raw, { signal, publish: true });
  }

  /** Read-only: the label-core document as it must already be in R2. */
  inspect(raw: unknown, signal: AbortSignal): Promise<LabelCoreOutcome> {
    return this.prepare(raw, { signal, publish: false });
  }

  private async prepare(raw: unknown, options: { signal: AbortSignal; publish: boolean }) {
    const { signal } = options;
    signal.throwIfAborted();
    const input = LabelCoreInputSchema.parse(raw);
    const full = await this.fullDocument(input, signal);
    const [policyName, policy] = this.policyFor(full.source);
    const html = decodeUtf8(
      (await this.deps.artifacts.resolve(full.source, input.owner, signal)).bytes,
    );
    const document = TextDocumentSchema.parse({
      ...input.owner,
      producer: "label.core.prepare",
      corePolicy: policyName,
      source: full.source,
      pageIndex: null,
      text: extracted(policy, html),
    });
    const ref = coreRef(input.owner, {
      source: full.source,
      policyName,
      bytes: encodeJson(document),
    });
    await this.published(ref, { document, ...options });
    const range = { start: 0, end: document.text.length };
    return LabelCoreOutcomeSchema.parse({ status: "prepared", input, document: ref, range });
  }

  /** The full prepared page the core is taken from: this observation's, from page preparation, not a PDF page. */
  private async fullDocument(input: LabelCoreInput, signal: AbortSignal) {
    const resolved = await this.deps.artifacts.resolve(input.fullDocument, input.owner, signal);
    const full = TextDocumentSchema.parse(decodeJson(resolved.bytes));
    const own =
      full.producer === "page.prepare" &&
      full.pageIndex === null &&
      isDeepStrictEqual(textObservation(full), input.owner);
    if (!own) {
      throw labelFailure("LABEL_CORE.IDENTITY_CONFLICT");
    }
    return full;
  }

  /** The one policy that reads pages from this source's producer. */
  private policyFor(source: ArtifactRef): [string, LabelCorePolicy] {
    const matching = Object.entries(this.deps.policies).filter(
      ([, policy]) =>
        source.kind === "source-html" &&
        policy.sourceModule === source.producer.module &&
        (policy.sourceVersion === undefined ||
          policy.sourceVersion === source.producer.implementationVersion),
    );
    const [only] = matching;
    if (!only || matching.length !== 1) {
      throw labelFailure("LABEL_CORE.SOURCE_UNSUPPORTED");
    }
    return only;
  }

  /** Content-addressed: re-publication never re-runs anything; the stored document must equal the derived one. */
  private async published(
    ref: ArtifactRef,
    options: { document: unknown; signal: AbortSignal; publish: boolean },
  ): Promise<void> {
    const { remote } = this.deps;
    const { signal } = options;
    const bytes = encodeJson(options.document);
    let saved = await remote.read(ref.objectKey, DOCUMENT_LIMIT, signal);
    if (!saved && options.publish) {
      try {
        await remote.create(ref.objectKey, bytes, "application/json", signal);
      } catch {
        // The read-back below decides.
      }
      saved = await remote.read(ref.objectKey, DOCUMENT_LIMIT, signal);
    }
    const same =
      !!saved &&
      sha256(saved) === ref.sha256 &&
      isDeepStrictEqual(TextDocumentSchema.parse(decodeJson(saved)), options.document);
    if (!same) {
      throw labelFailure("LABEL_CORE.HANDOFF_UNVERIFIED");
    }
  }
}

/** The channel's reader output; a failure keeps its own code, and an uncoded one is recorded as such. */
function extracted(policy: LabelCorePolicy, html: string): string {
  try {
    return policy.extract(html);
  } catch (error) {
    if (errorCodeOf(error)?.startsWith("LABEL_CORE.")) {
      throw error;
    }
    throw labelFailure("LABEL_CORE.EXTRACTION_FAILED", error);
  }
}

function coreRef(
  owner: Observation,
  core: { source: ArtifactRef; policyName: string; bytes: Uint8Array },
): ArtifactRef {
  const { source, policyName, bytes } = core;
  const operationId = `core-${sha256(encodeJson([owner, source, policyName]))}`;
  return ArtifactRefSchema.parse({
    ...source,
    kind: "result-json",
    mediaType: "application/json",
    artifactId: operationId,
    objectKey: `v3/label-core/${operationId}/document.json`,
    byteSize: bytes.length,
    sha256: sha256(bytes),
    producer: { operationId, module: "label.core.prepare", implementationVersion: policyName },
  });
}
