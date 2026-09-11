import { expect, it, vi } from "vitest";
import { TextCandidateV3Schema, TextInputSchema, TextOutputSchema, PreparedTextWorkflowInputSchema, ProductEvidenceSourceSchema, textFingerprint, assertTextQuotes } from "@crawl-automation/v3-contracts";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { TextModule } from "./module.js";
import { TextHandoff, hashText } from "./handoff.js";
import { ResolveTextReceipt } from "./receipt.js";
import { CodexTextProvider, CodexTextConfigSchema } from "./codex-provider.js";
import { labelExecutionFixture, labelConfig } from "./label-execution.fixture.js";
const signal = () => AbortSignal.timeout(5000);
function setup() {
  const f = labelExecutionFixture(), interpret = vi.fn(async (_request: unknown) => JSON.stringify(f.wire));
  const provider = { ...f.provider, supported: f.supported, interpret };
  const module = new TextModule({ ...f.deps, provider });
  return { ...f, provider, module, interpret };
}
it("explicit opt-in changes compatibility, defaults retain their exact old fingerprint", () => {
  const old = CodexTextProvider.describe(labelConfig), newer = CodexTextProvider.describe({ ...labelConfig, extractionProtocol: "label-extraction/1" });
  expect(old.configFingerprint).toBe("4f24837981b37edc5150b2704a8d810a86f9083c0b6cd96d241db6168216cdae");
  expect(newer).toMatchObject({ implementationVersion: "codex-text/3", policyVersion: "label-text/4", resultSchemaVersion: 3 });
  expect(newer.configFingerprint).not.toBe(old.configFingerprint);
  expect(CodexTextProvider.describe({ ...labelConfig, extractionProtocol: "label-extraction/1", codexHome: "/elsewhere" })).toEqual(newer);
  expect(CodexTextProvider.describe({ ...labelConfig, extractionProtocol: "label-extraction/1", timeoutMs: 120000 })).not.toEqual(newer);
  expect(CodexTextConfigSchema.safeParse({ ...labelConfig, extractionProtocol: "automatic" }).success).toBe(false);
});
it("executes the grouped schema, retains raw evidence and registers exact V3 output", async () => {
  const f = setup(); expect(await f.module.run(f.input, signal())).toMatchObject({ status: "registered" });
  const request = f.interpret.mock.calls[0]![0] as { prompt: string; outputSchema: unknown };
  expect(request.prompt).toContain("SAME ROW"); expect(JSON.stringify(request.outputSchema)).toContain("label-extraction/1");
  expect(await f.local.read(f.handoff.responseKey(f.input), 524288)).not.toBeNull();
  const record = f.registry.data.get(f.input.operationId)!;
  const output = TextOutputSchema.parse(JSON.parse(Buffer.from(f.remote.data.get(record.result.objectKey)!).toString()));
  expect(output.resultSchemaVersion).toBe(3);
  const candidate = TextCandidateV3Schema.parse(output.candidate);
  expect(candidate.formula!.columns[0]!.rows[14]).toMatchObject({ parentRowIndex: 13, amount: { text: "100 mg" } });
  expect(record.result.producer.implementationVersion).toBe("codex-text/3");
  assertTextQuotes(candidate, f.input, f.text); expect(f.interpret).toHaveBeenCalledOnce();
});
it("a replacement receipt reader re-decodes with no model, upload or registration calls", async () => {
  const f = setup(), outcome = await f.module.run(f.input, signal()), writes = f.remote.writes;
  const register = vi.spyOn(f.registry, "register"); register.mockClear();
  const cold = new TextHandoff(new MemoryObjects(), f.remote, f.registry, f.evidence, f.handoff.storageId);
  const reader = new ResolveTextReceipt({ results: cold, local: new MemoryObjects(), reviews: f.reviews });
  expect(await reader.run({ input: f.input, outcome }, signal())).toMatchObject({ status: "registered" });
  expect(f.remote.writes).toBe(writes); expect(register).not.toHaveBeenCalled(); expect(f.interpret).toHaveBeenCalledOnce();
  expect(await f.module.run(f.input, signal())).toEqual(outcome); expect(f.interpret).toHaveBeenCalledOnce();
});
it("wrong policy and wrong provider configuration cannot start a model turn", async () => {
  const f = setup(); expect(TextInputSchema.safeParse({ ...f.input, policyVersion: "anchored/2" }).success).toBe(false);
  const wrong = { ...f.input, configFingerprint: "b".repeat(64) }; wrong.inputFingerprint = textFingerprint(wrong, hashText);
  await expect(f.module.run(wrong, signal())).rejects.toThrow("TEXT.INVALID_INPUT");
  expect(f.interpret).not.toHaveBeenCalled(); expect(f.remote.writes).toBe(0);
});
it("quality failures preserve the raw response and do not execute again on redelivery", async () => {
  const f = setup(), row = f.wire.formula!.columns[0]!.rows[5]!; row.amount = null; row.amountStatus = "unreadable";
  const outcome = await f.module.run(f.input, signal());
  expect(outcome).toMatchObject({ status: "review", code: "TEXT.LABEL_AMOUNT_UNREADABLE" });
  const review = [...f.reviews.records.values()][0]!;
  expect(review.candidate?.value).toEqual({ rawResponse: JSON.stringify(f.wire) }); expect(f.registry.data.size).toBe(0);
  expect(await f.module.run(f.input, signal())).toMatchObject({ status: "review", code: "TEXT.EXECUTION_UNKNOWN" });
  expect(f.interpret).toHaveBeenCalledOnce();
  const reader = new ResolveTextReceipt({ results: f.handoff, local: f.local, reviews: f.reviews });
  expect(await reader.run({ input: f.input, outcome }, signal())).toMatchObject({ status: "review", code: "TEXT.LABEL_AMOUNT_UNREADABLE" });
});
it("an old output shape cannot satisfy a new task", async () => {
  const f = setup(); f.interpret.mockResolvedValueOnce('{"formula":null,"ingredients":null}');
  expect(await f.module.run(f.input, signal())).toMatchObject({ status: "review", code: "TEXT.LABEL_INVALID_OUTPUT" });
  expect(f.registry.data.size).toBe(0);
});
it.each(["source", "result", "completion"])("cold inspection rejects corrupt %s without a model turn", async what => {
  const f = setup(); await f.module.run(f.input, signal()); const record = f.registry.data.get(f.input.operationId)!;
  const key = what === "source" ? f.ref.objectKey : record[what as "result" | "completion"].objectKey;
  f.remote.data.set(key, Buffer.from("corrupt")); const writes = f.remote.writes;
  await expect(new TextHandoff(new MemoryObjects(), f.remote, f.registry, f.evidence, f.handoff.storageId).inspect(f.input, signal())).rejects.toThrow();
  expect(f.remote.writes).toBe(writes); expect(f.interpret).toHaveBeenCalledOnce();
});
it("a lost registration acknowledgment is reconciled instead of executing again", async () => {
  const f = setup(); f.registry.lost = true;
  expect(await f.module.run(f.input, signal())).toMatchObject({ status: "registered" }); expect(f.interpret).toHaveBeenCalledOnce();
});
it("an unavailable registration leaves computed evidence and does not restart the model", async () => {
  const f = setup(); f.registry.unavailable = true;
  expect(await f.module.run(f.input, signal())).toMatchObject({ status: "review" });
  expect(await f.handoff.inspect(f.input, signal())).toMatchObject({ computedLocal: true, artifactDurable: true, resultRegistered: false });
  expect(await f.module.run(f.input, signal())).toMatchObject({ status: "review", code: "TEXT.HANDOFF_INCOMPLETE" });
  expect(f.interpret).toHaveBeenCalledOnce(); expect(f.registry.data.size).toBe(0);
});
it("changed configuration cannot reuse an old operation even with a matching new provider", async () => {
  const f = setup(); await f.module.run(f.input, signal());
  const input = { ...f.input, configFingerprint: "b".repeat(64) }; input.inputFingerprint = textFingerprint(input, hashText);
  const provider = { ...f.provider, supported: { ...f.supported, configFingerprint: input.configFingerprint } };
  expect(await new TextModule({ ...f.deps, provider }).run(input, signal())).toMatchObject({ status: "review", code: "TEXT.RESULT_CONFLICT" });
  expect(f.interpret).toHaveBeenCalledOnce(); expect(f.registry.data.get(f.input.operationId)!.input).toEqual(f.input);
});
it("new quote fields and output version cannot be forged at handoff", async () => {
  const f = setup(); await f.module.run(f.input, signal()); const r = f.registry.data.get(f.input.operationId)!;
  const output = TextOutputSchema.parse(JSON.parse(Buffer.from(f.remote.data.get(r.result.objectKey)!).toString()));
  expect(TextOutputSchema.safeParse({ ...output, resultSchemaVersion: 2 }).success).toBe(false);
  const candidate = TextCandidateV3Schema.parse(output.candidate); candidate.formula!.servingsPerContainer!.start++;
  expect(() => assertTextQuotes(candidate, f.input, f.text)).toThrow("TEXT.CITATION_INVALID");
  await expect(f.handoff.capture(f.input, { ...output, candidate }, signal())).rejects.toThrow();
});
it("new prepared tasks are accepted by their workflow envelope but not the legacy product manifest", () => {
  const f = setup();
  expect(PreparedTextWorkflowInputSchema.safeParse({ task: f.input, queues: { text: "new-text", receipts: "receipt" } }).success).toBe(true);
  expect(ProductEvidenceSourceSchema.safeParse({ id: "text", required: true, kind: "text", task: f.input }).success).toBe(false);
});
