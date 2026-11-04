import { randomUUID } from "node:crypto";
import { ArtifactResolver } from "@crawl-automation/platform";
import {
  TextInputSchema,
  textFingerprint,
  type ArtifactRef,
  type TextCompatibility,
  type TextRecord,
} from "@crawl-automation/v3-contracts";
import { TextEvidence } from "../evidence/text-evidence.js";
import type { LabelCorePolicies } from "../evidence/label-core-policy.js";
import type { TextModel } from "../ports.js";
import { hashText } from "../results/text-record.js";
import { TextResultRecovery } from "../results/text-result-recovery.js";
import { TextResults } from "../results/text-results.js";
import { TextStep } from "../step/text-step.js";
import { MemoryRegistry, MemoryReviews } from "../../testing/memory-ledgers.js";
import { MemoryStore } from "../../testing/memory-store.js";
import {
  LABEL_CORE_POLICY,
  LABEL_CORE_PRODUCER,
  fixtureArtifact,
  type Owner,
} from "./text-fixture-artifacts.js";

export const signal = () => new AbortController().signal;

const SUPPORTED: TextCompatibility = {
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

export interface TextFixtureOptions {
  text?: string;
  labelCores?: LabelCorePolicies;
  /** A label-core facts document (label-text/6 task) read from this page; its policy re-derives `text` as is. */
  labelCore?: { html: string; transcriptPolicies?: readonly string[] };
}

const LABEL_SUPPORTED: TextCompatibility = {
  ...SUPPORTED,
  implementationVersion: "codex-text/3",
  policyVersion: "label-text/6",
  resultSchemaVersion: 3,
};

/** A prepared page-text task with its source in a remote store, and every part of the text step wired up. */
export function textFixture(options: TextFixtureOptions = {}) {
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
  const core = options.labelCore;
  const { source, ref } = storeSource({
    remote,
    owner,
    text,
    ...(core ? { html: core.html } : {}),
  });
  const supported = core ? LABEL_SUPPORTED : SUPPORTED;
  const input = signedTask(owner, ref, { text, supported });
  const corePolicies = core
    ? { [LABEL_CORE_POLICY]: { sourceModule: "page.prepare", extract: () => text } }
    : {};
  return wire({
    text,
    input,
    local: new MemoryStore(),
    remote,
    ref,
    source,
    labelCores: { ...corePolicies, ...options.labelCores },
    supported,
    transcriptPolicies: core?.transcriptPolicies ?? [],
  });
}

/** The source page and the prepared document made from it, both in the remote store. */
function storeSource(parts: { remote: MemoryStore; owner: Owner; text: string; html?: string }) {
  const { remote, owner, text } = parts;
  const html = Buffer.from(parts.html ?? `<p>${text}</p>`);
  const source = fixtureArtifact(owner, "source-html", { bytes: html, suffix: "html" });
  const prepared = { ...owner, source, pageIndex: null, text };
  const labelCore = parts.html !== undefined;
  const document = labelCore
    ? { ...prepared, producer: "label.core.prepare", corePolicy: LABEL_CORE_POLICY }
    : { ...prepared, producer: "page.prepare" };
  const documentBytes = Buffer.from(JSON.stringify(document));
  const ref = fixtureArtifact(owner, "result-json", {
    bytes: documentBytes,
    suffix: "document",
    ...(labelCore ? { producer: LABEL_CORE_PRODUCER } : {}),
  });
  remote.data.set(source.objectKey, html);
  remote.data.set(ref.objectKey, documentBytes);
  return { source, ref };
}

/** The text task over the whole document, with its fingerprint. */
function signedTask(
  owner: Owner,
  ref: ArtifactRef,
  task: { text: string; supported: TextCompatibility },
) {
  const { text, supported } = task;
  const unsigned = {
    ...owner,
    ...supported,
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
  supported: TextCompatibility;
  transcriptPolicies: readonly string[];
}) {
  const cache = { read: async () => null, retain: async () => {} };
  const unusedOcr = {
    inspect: async (): Promise<never> => {
      throw new Error("prepared text never reads OCR");
    },
  };
  const artifacts = new ArtifactResolver(cache, parts.remote);
  const evidence = new TextEvidence({ artifacts, ocr: unusedOcr, labelCores: parts.labelCores });
  const registry = new MemoryRegistry<TextRecord>();
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
  const model = Object.assign(quotingModel(parts.text), { supported: parts.supported });
  const step = new TextStep({
    model,
    results,
    reviews,
    nodeId: "test-node",
    transcriptPolicies: parts.transcriptPolicies,
  });
  return { ...parts, evidence, registry, reviews, results, recovery, model, step, artifacts };
}
