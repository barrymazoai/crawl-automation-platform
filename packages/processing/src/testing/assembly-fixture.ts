import { vi } from "vitest";
import {
  LabelProductJoinSchema,
  type LabelCollectedProduct,
  type LabelImageCandidate,
  type PackagingFacts,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import { LabelAssembly } from "../assembly/label-assembly.js";
import { LabelCollection } from "../assembly/label-collection.js";
import type { VerifiedLabelSource } from "../assembly/label-merge.js";
import {
  fixtureObservation,
  imageSource,
  labelCandidate,
  visionFingerprint,
} from "./label-sources.js";
import { MemoryStore } from "./memory-store.js";

export { labelCandidate, textEntry, visionFingerprint } from "./label-sources.js";

/** The Review and collected-product ledgers, in memory, with spies. */
function ledgers() {
  const records = new Map<string, ReviewRecord>();
  const collected = new Map<string, LabelCollectedProduct>();
  const reviews = {
    read: vi.fn(async (id: string) => records.get(id) ?? null),
    append: vi.fn(async (record: ReviewRecord) => {
      records.set(record.reviewId, record);
    }),
  };
  const registry = {
    read: vi.fn(async (id: string) => collected.get(id) ?? null),
    append: vi.fn(async (record: LabelCollectedProduct) => {
      collected.set(record.operationId, record);
    }),
  };
  return { records, collected, reviews, registry };
}

/** A verified-source reader over the given entries (a stand-in for the production readers). */
function readerOf(entries: Map<string, VerifiedLabelSource>) {
  return vi.fn(async (source: { id: string }): Promise<VerifiedLabelSource> => {
    const entry = entries.get(source.id);
    if (!entry) {
      throw new Error("unknown source");
    }
    return structuredClone(entry);
  });
}

type Deps = ConstructorParameters<typeof LabelAssembly>[0];
type Registry = ReturnType<typeof ledgers>["registry"];

/** Assembly and collection over these stores, and the same steps on a worker with an empty local store. */
function stepsOf(deps: Deps, registry: Registry) {
  const assembly = new LabelAssembly(deps);
  const collector = new LabelCollection({ ...deps, assembly, registry });
  const cold = () => {
    const next = { ...deps, local: new MemoryStore() };
    const coldAssembly = new LabelAssembly(next);
    return {
      assembly: coldAssembly,
      collector: new LabelCollection({ ...next, assembly: coldAssembly, registry }),
    };
  };
  return { assembly, collector, cold };
}

/** A product whose image sources are registered, with assembly and collection wired to memory stores. */
export function assemblySetup(candidates: LabelImageCandidate[] = [labelCandidate()]) {
  const images = candidates.map(imageSource);
  const sources = images.map((image) => image.source);
  const manifest = { operationId: "label-product", observation: fixtureObservation, sources };
  const states = images.map((image) => ({ id: image.source.id, status: "registered" }));
  const join = LabelProductJoinSchema.parse({ manifest, states });
  const { records, collected, reviews, registry } = ledgers();
  const entries = new Map(images.map((image) => [image.entry.id, image.entry]));
  const readPackaging = vi.fn(async (): Promise<PackagingFacts> =>
    Promise.reject(new Error("no packaging")),
  );
  const [local, remote] = [new MemoryStore(), new MemoryStore()];
  const readSource = readerOf(entries);
  const deps = { local, remote, reviews, readSource, readPackaging, visionFingerprint };
  const steps = stepsOf(deps, registry);
  const observation = fixtureObservation;
  return {
    join,
    deps,
    ...steps,
    registry,
    collected,
    records,
    remote,
    local,
    entries,
    observation,
  };
}
