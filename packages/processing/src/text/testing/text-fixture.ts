import { randomUUID } from "node:crypto";
import { ArtifactResolver, sha256 } from "@crawl-automation/v3-artifacts";
import {
  ArtifactRefSchema,
  TextInputSchema,
  textFingerprint,
  type ArtifactRef,
} from "@crawl-automation/v3-contracts";
import { TextEvidence } from "../evidence/text-evidence.js";
import type { LabelCorePolicies } from "../evidence/label-core-policy.js";
import type { TextModel } from "../ports.js";
import { hashText } from "../results/text-record.js";
import { TextResultRecovery } from "../results/text-result-recovery.js";
import { TextResults } from "../results/text-results.js";
import { TextStep } from "../step/text-step.js";
import { MemoryReviews, MemoryTextRegistry } from "./memory-ledgers.js";
import { MemoryStore } from "./memory-store.js";

export const signal = () => new AbortController().signal;

const SUPPORTED = {
  schemaVersion: 1 as const,
  module: "codex.text" as const,
  implementationVersion: "text/1",
  policyVersion: "extractive/1",
  resultSchemaVersion: 1 as const,
  configFingerprint: "a".repeat(64),
};

/** A model that answers every task with one ingredient quote spanning the whole text. */
export function quotingModel(text: string): TextModel & { calls: number } {
  const model = {
    provider: "fixture/1",
    supported: SUPPORTED,
    policy: {
      executionRetries: 0 as const,
      internalModelRequests: "no-retries" as const,
      toolAccess: "runtime-profile" as const,
      modelFallback: false as const,
      networkSwitching: false as const,
    },
    calls: 0,
    async interpret() {
      model.calls++;
      return JSON.stringify({
        formula: null,
        ingredients: { items: [{ text, start: 0, end: text.length }] },
      });
    },
    async close() {},
  };
  return model;
}

type Owner = {
  schemaVersion: 1;
  requestId: string;
  observationId: string;
  brandId: string;
  sourceId: string;
  listingId: string;
  variantId: null;
};

/** A prepared page-text task with its source in a remote store, and every part of the text step wired up. */
export function textFixture(options: { text?: string; labelCores?: LabelCorePolicies } = {}) {
  const text = options.text ?? "Vitamin C 10 mg\nIngredients: water";
  const id = randomUUID();
  const remote = new MemoryStore();
  const owner: Owner = {
    schemaVersion: 1,
    requestId: `req-${id}`,
    observationId: `obs-${id}`,
    brandId: "brand-test",
    sourceId: "source-test",
    listingId: `listing-${id}`,
    variantId: null,
  };
  const { source, ref } = storeSource({ remote, owner, text });
  const input = signedTask(owner, ref, text);
  return wire({
    text,
    input,
    local: new MemoryStore(),
    remote,
    ref,
    source,
    labelCores: options.labelCores ?? {},
  });
}

/** The source page and the prepared document made from it, both in the remote store. */
function storeSource(parts: { remote: MemoryStore; owner: Owner; text: string }) {
  const { remote, owner, text } = parts;
  const artifact = (
    kind: "source-html" | "result-json",
    bytes: Uint8Array,
    suffix: string,
  ): ArtifactRef =>
    ArtifactRefSchema.parse({
      schemaVersion: 1,
      artifactId: `${suffix}-${owner.observationId}`,
      observationId: owner.observationId,
      sourceId: owner.sourceId,
      listingId: owner.listingId,
      variantId: null,
      kind,
      mediaType: kind === "source-html" ? "text/html" : "application/json",
      objectKey: `sources/${owner.observationId}/${suffix}`,
      sha256: sha256(bytes),
      byteSize: bytes.length,
      producer: {
        operationId: `prepare-${owner.observationId}`,
        module: "page.prepare",
        implementationVersion: "fixture/1",
      },
    });
  const html = Buffer.from(`<p>${text}</p>`);
  const source = artifact("source-html", html, "html");
  const document = { ...owner, producer: "page.prepare", source, pageIndex: null, text };
  const documentBytes = Buffer.from(JSON.stringify(document));
  const ref = artifact("result-json", documentBytes, "document");
  remote.data.set(source.objectKey, html);
  remote.data.set(ref.objectKey, documentBytes);
  return { source, ref };
}

/** The text task over the whole document, with its fingerprint. */
function signedTask(owner: Owner, ref: ArtifactRef, text: string) {
  const unsigned = {
    ...owner,
    ...SUPPORTED,
    operationId: `text-${owner.observationId}`,
    source: { kind: "prepared" as const, document: ref },
    range: { start: 0, end: text.length },
  };
  return TextInputSchema.parse({
    ...unsigned,
    inputFingerprint: textFingerprint(unsigned, hashText),
  });
}

function wire(parts: {
  text: string;
  input: ReturnType<typeof TextInputSchema.parse>;
  local: MemoryStore;
  remote: MemoryStore;
  ref: ArtifactRef;
  source: ArtifactRef;
  labelCores: LabelCorePolicies;
}) {
  const cache = { read: async () => null, retain: async () => {} };
  const unusedOcr = {
    inspect: async (): Promise<never> => {
      throw new Error("prepared text never reads OCR");
    },
  };
  const artifacts = new ArtifactResolver(cache, parts.remote);
  const evidence = new TextEvidence({ artifacts, ocr: unusedOcr, labelCores: parts.labelCores });
  const registry = new MemoryTextRegistry();
  const reviews = new MemoryReviews();
  const deps = {
    local: parts.local,
    remote: parts.remote,
    registry,
    evidence,
    storageId: "fixture/1",
  };
  const results = new TextResults(deps);
  const recovery = new TextResultRecovery(results, deps);
  const model = quotingModel(parts.text);
  const step = new TextStep({ model, results, reviews, nodeId: "test-node" });
  return { ...parts, evidence, registry, reviews, results, recovery, model, step, artifacts };
}
