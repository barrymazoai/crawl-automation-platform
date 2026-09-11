import { vi } from "vitest";
import { LabelProductJoinSchema, type PackagingFacts, type LabelCollectedProduct, type ReviewRecord, type LabelImageCandidate } from "@crawl-automation/v3-contracts";
import { labelExecutionFixture } from "../../v3-vision/src/label-execution.fixture.js";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { gncLabelFixture } from "../../v3-contracts/src/label.fixture.js";
import { LabelProductAssembly, CollectLabelProduct } from "./label-product.js";
export async function labelProductFixture(candidates: LabelImageCandidate[] = [gncLabelFixture()], execute = true) {
  const sources = [], inputs: ReturnType<typeof labelExecutionFixture>[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const f = labelExecutionFixture(JSON.stringify(candidate)); f.task.input.operationId = `label-source-${index}`;
    if (execute) {
      const out = await f.module.run(f.task.input, new AbortController().signal);
      if (out.status !== "candidate" && out.status !== "partial") throw Error(`Invalid synthetic label: ${out.code}`);
      await f.handoff.complete(f.task, new AbortController().signal);
    }
    sources.push({ id: `source-${index}`, kind: "image" as const, required: true, task: f.task }); inputs.push(f);
  }
  const join = LabelProductJoinSchema.parse({ manifest: { operationId: "label-product", observation: inputs[0]!.task.input.selection.observation, sources },
    states: sources.map(s => ({ id: s.id, status: "registered" })) });
  const local = new MemoryObjects(), remote = new MemoryObjects(), records = new Map<string, ReviewRecord>(), collected = new Map<string, LabelCollectedProduct>();
  const reviews = { read: vi.fn(async (id: string) => records.get(id) ?? null), append: vi.fn(async (r: ReviewRecord) => { records.set(r.reviewId, r); }) };
  const registry = { read: vi.fn(async (id: string) => collected.get(id) ?? null), append: vi.fn(async (r: LabelCollectedProduct) => { collected.set(r.operationId, r); }) };
  const readSource = vi.fn(async (s: typeof join.manifest.sources[number], signal: AbortSignal) => {
    if (s.kind !== "image") throw Error("image fixture only");
    const f = inputs[Number(s.id.slice(7))]!;
    return { id: s.id, kind: "image" as const, ...await f.handoff.readLabelCandidate(s.task, signal) };
  });
  const readPackaging = vi.fn<() => Promise<PackagingFacts>>(async () => { throw Error("LABEL_PRODUCT.PACKAGING_UNVERIFIED"); });
  const deps = { local, remote, reviews, readSource, readPackaging }, assembly = new LabelProductAssembly(deps);
  const collector = new CollectLabelProduct({ ...deps, assembly, registry });
  return { join, deps, assembly, collector, registry, collected, inputs, records, remote, local,
    cold: () => { const next = { ...deps, local: new MemoryObjects() }, a = new LabelProductAssembly(next); return { assembly: a, collector: new CollectLabelProduct({ ...next, assembly: a, registry }) }; } };
}
