import { expect, it } from "vitest";
import { TextOutputSchema, TextCandidateV3Schema, LabelProductJoinSchema, type LabelCollectedProduct } from "@crawl-automation/v3-contracts";
import { TextModule } from "../../v3-text/src/module.js";
import { labelExecutionFixture } from "../../v3-text/src/label-execution.fixture.js";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { LabelProductAssembly, CollectLabelProduct, type LabelCollectedRegistry } from "./label-product.js";
import { mergeLabelProduct } from "./label-merge.js";
it("prepared text V3 produces exact citations and independent collection without vision", async () => {
  const f = labelExecutionFixture(), provider = { ...f.provider, supported: f.supported, interpret: async () => JSON.stringify(f.wire) };
  expect((await new TextModule({ ...f.deps, provider }).run(f.input, AbortSignal.timeout(10000))).status).toBe("registered");
  const join = LabelProductJoinSchema.parse({ manifest: { operationId: "text-label-product", observation: f.owner,
    sources: [{ id: "text", kind: "text", required: true, task: f.input }] }, states: [{ id: "text", status: "registered" }] });
  const readSource = async () => {
    const facts = await f.handoff.inspect(f.input, AbortSignal.timeout(10000));
    if (!facts.resultRegistered || !facts.artifactDurable || !facts.record) throw Error();
    const output = TextOutputSchema.parse(JSON.parse(Buffer.from(f.remote.data.get(facts.record.result.objectKey)!).toString()));
    return { id: "text", kind: "text" as const, record: facts.record, candidate: TextCandidateV3Schema.parse(output.candidate), fullText: f.text };
  };
  const deps = { local: new MemoryObjects(), remote: f.remote, reviews: f.reviews, readSource }, assembly = new LabelProductAssembly(deps);
  let saved: Awaited<ReturnType<LabelCollectedRegistry["read"]>> = null;
  const collector = new CollectLabelProduct({ ...deps, assembly, registry: { read: async () => saved, append: async r => { saved = r; } } });
  const out = await assembly.run(join, AbortSignal.timeout(10000)); expect(out.status).toBe("ready");
  expect((await collector.run({ join, evidenceKey: out.evidenceKey }, AbortSignal.timeout(10000))).status).toBe("collected");
  const row = (saved as unknown as LabelCollectedProduct).formula.columns[0]!.rows[5]!;
  expect(row.amount).toMatchObject({ text: "200 mg", citation: { kind: "text" } });
  const entry = await readSource(); entry.candidate.formula!.columns[0]!.rows[5]!.amount!.start++;
  expect(() => mergeLabelProduct(join.manifest, [entry])).toThrow("TEXT.CITATION_INVALID");
});
