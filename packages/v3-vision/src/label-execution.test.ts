import { expect, it, vi } from "vitest";
import { CodexExecutionConfigSchema } from "@crawl-automation/v3-codex";
import { VisionRecordSchema, VisionInputSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { gncLabelFixture } from "../../v3-contracts/src/label.fixture.js";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { labelConfig, labelExecutionFixture } from "./label-execution.fixture.js";
import { CodexVisionProvider } from "./provider.js";
import { visionPrompt, visionOutputSchema, visionValidationVersion } from "./extraction.js";
import { digest } from "./keywords.js";
import { VisionModule } from "./module.js";
import { VisionHandoff, PostgresVisionRegistry } from "./handoff.js";
import { visionReviewWriter } from "./review.js";
import { inspectSavedVisionReview } from "./review-recovery.js";
import { candidate as legacy } from "./testing.fixture.js";
const signal = () => AbortSignal.timeout(5000);

it("visual wire v2 is pinned and survives independent cold registration decoding",async()=>{
 const label=gncLabelFixture(),body=label.otherIngredients!.items.map(i=>i.text).join(", ");
 const raw=JSON.stringify({codec:"label-visual-wire/2",label,otherIngredientsBlock:{text:body,evidence:body}}),f=labelExecutionFixture(raw);
 const config=CodexVisionProvider.describe({...labelConfig,extractionProtocol:"label-extraction/2"});
 expect(config.configFingerprint).not.toBe(f.task.configFingerprint);
 const task={input:{...f.task.input,extractionProtocol:"label-extraction/2" as const},configFingerprint:config.configFingerprint};
 const provider={...f.provider,extractionProtocol:"label-extraction/2" as const,fingerprint:config.configFingerprint};
 const module=new VisionModule({...f.dependencies,provider});
 expect((await module.run(task.input,signal())).status).toBe("candidate");
 await f.handoff.complete(task,signal());
 const cold=new VisionHandoff(new MemoryObjects(),f.remote,f.registry,"test/1",f.verify),writes=f.remote.writes;
 expect((await cold.readLabelCandidate(task,signal())).candidate).toEqual(label);
 expect((await module.run(task.input,signal())).replayed).toBe(true);expect(provider.interpret).toHaveBeenCalledOnce();expect(f.remote.writes).toBe(writes);
 await expect(cold.inspect(f.task,signal())).rejects.toThrow();
});

it("opts in explicitly while preserving the exact legacy fingerprint material", () => {
  const { extractionProtocol, ...old } = labelConfig;
  // The legacy provider hashes schema-normalized settings, not caller key insertion order.
  const normalized = CodexExecutionConfigSchema.parse(old);
  const before = digest(JSON.stringify(["codex-vision/1", normalized.settings, normalized.runtimeProfileVersion,
    normalized.timeoutMs, "original", visionPrompt, visionOutputSchema, visionValidationVersion]));
  expect(before).toBe("41ee303bd523320e32cd67c24cbfb5aa4e34278859dd6b1154f8a928a5bf1a8a");
  expect(CodexVisionProvider.describe(old)).toEqual({ configFingerprint: before });
  const next = CodexVisionProvider.describe(labelConfig);
  expect(next.extractionProtocol).toBe(extractionProtocol); expect(next.configFingerprint).not.toBe(before);
  expect(CodexVisionProvider.describe({ ...labelConfig, codexHome: "/another/profile" })).toEqual(next);
  expect(CodexVisionProvider.describe({ ...labelConfig, timeoutMs: 200000 }).configFingerprint).not.toBe(next.configFingerprint);
  expect(() => CodexVisionProvider.describe({ ...labelConfig, extractionProtocol: "auto" })).toThrow();
  expect(() => VisionInputSchema.parse({ ...labelExecutionFixture().task.input, extractionProtocol: "auto" })).toThrow();
});
it("retains grouped rows and original raw bytes, registers v2 and cold verifies without a model or writes", async () => {
  const f = labelExecutionFixture();
  expect(await f.module.run(f.task.input, signal())).toMatchObject({ status: "candidate", candidate: gncLabelFixture() });
  const record = await f.handoff.complete(f.task, signal());
  expect(record).toMatchObject({ schemaVersion: 2, codec: "vision-result/2", result: { producer: { implementationVersion: "vision/2" } } });
  const raw = JSON.parse(Buffer.from(f.remote.data.get(record.result.objectKey)!).toString());
  expect(raw.raw).toBe(JSON.stringify(gncLabelFixture()));
  expect(JSON.parse(Buffer.from(f.remote.data.get(record.completion.objectKey)!).toString())).toMatchObject({ codec: "vision-completion/2", schemaVersion: 2 });
  f.local.data.clear(); const writes = f.remote.writes, localWrites = f.local.writes;
  const cold = new VisionHandoff(new MemoryObjects(), f.remote, f.registry, "test/1", f.verify);
  expect(await cold.inspect(f.task, signal())).toEqual(record);
  expect((await cold.readLabelCandidate(f.task, signal())).candidate).toEqual(gncLabelFixture());
  expect(await new VisionModule(f.dependencies).run(f.task.input, signal())).toMatchObject({ status: "candidate", replayed: true });
  expect(f.remote.writes).toBe(writes); expect(f.local.writes).toBe(localWrites); expect(f.provider.interpret).toHaveBeenCalledOnce();
  expect(f.registry.register).toHaveBeenCalledOnce();
});
it("legacy consumer cannot flatten a label candidate and label consumer rejects old input", async () => {
  const f = labelExecutionFixture(); await f.module.run(f.task.input, signal()); await f.handoff.complete(f.task, signal());
  await expect(f.handoff.readCandidate(f.task, signal())).rejects.toThrow("VISION.LEGACY_PROTOCOL_UNSUPPORTED");
  const { extractionProtocol, ...input } = f.task.input;
  await expect(f.handoff.readLabelCandidate({ ...f.task, input }, signal())).rejects.toThrow("VISION.LABEL_PROTOCOL_REQUIRED");
});
it.each(["old-provider", "old-task"])("rejects %s protocol mismatch before source reads or execution", async side => {
  const f = labelExecutionFixture(), { extractionProtocol, ...oldProvider } = f.provider;
  const { extractionProtocol: _, ...oldInput } = f.task.input;
  const module = new VisionModule({ ...f.dependencies, provider: side === "old-provider" ? oldProvider : f.provider });
  expect(await module.run(side === "old-provider" ? f.task.input : oldInput, signal())).toMatchObject({ code: "VISION.CONFIG_MISMATCH" });
  expect(f.dependencies.verifiedOcrText).not.toHaveBeenCalled(); expect(f.provider.interpret).not.toHaveBeenCalled(); expect(f.remote.writes).toBe(0);
});
it("old output is retained but cannot be silently reinterpreted as the new protocol", async () => {
  const f = labelExecutionFixture(JSON.stringify(legacy));
  expect(await f.module.run(f.task.input, signal())).toMatchObject({ status: "review", code: "VISION.INVALID_OUTPUT" });
  await expect(f.handoff.complete(f.task, signal())).rejects.toThrow();
  expect(await f.module.run(f.task.input, signal())).toMatchObject({ status: "review", replayed: true });
  expect(f.remote.data.has("v3/vision/vision-label-1/response.json")).toBe(true); expect(f.provider.interpret).toHaveBeenCalledOnce(); expect(f.records.size).toBe(0);
});
it("missing component dose stays classified Review, including read-only recovery and new candidate codec", async () => {
  const c = gncLabelFixture(); c.formula!.columns[0]!.rows[14]!.amount = null;
  const f = labelExecutionFixture(JSON.stringify(c)), outcome = await f.module.run(f.task.input, signal());
  expect(outcome.status).toBe("review"); expect(outcome.code).toMatch(/^VISION\.LABEL_/);
  const append = vi.fn(async (r: ReviewRecord) => ({ reviewId: r.reviewId }));
  await visionReviewWriter(f.local, { append })(f.task, outcome, signal());
  expect(append.mock.calls[0]![0]).toMatchObject({ candidate: { schema: "label-extraction/1", value: c }, failure: { executionFact: "executed", automaticRetry: false } });
  const writes = f.remote.writes, localWrites = f.local.writes;
  const recovered = await inspectSavedVisionReview(f.task, { remote: f.remote, local: new MemoryObjects(), verifiedOcrText: f.dependencies.verifiedOcrText }, signal());
  expect(recovered).toEqual({ ...outcome, replayed: true });
  expect(f.remote.writes).toBe(writes); expect(f.local.writes).toBe(localWrites); expect(f.provider.interpret).toHaveBeenCalledOnce();
  await expect(f.handoff.complete(f.task, signal())).rejects.toThrow("VISION.RESULT_NOT_ACCEPTED");
});
it("useful partial evidence registers without implying product eligibility", async () => {
  const c = gncLabelFixture(); c.formula = null; c.formulaComplete = false;
  c.issues = [{ code: "FORMULA_MISSING", detail: "another image" }];
  const f = labelExecutionFixture(JSON.stringify(c));
  expect(await f.module.run(f.task.input, signal())).toMatchObject({ status: "partial" });
  expect(await f.handoff.complete(f.task, signal())).toMatchObject({ codec: "vision-result/2", status: "partial" });
});
it.each(["image", "response", "completion"])("cold inspection rejects corrupt %s without model or writes", async part => {
  const f = labelExecutionFixture(); await f.module.run(f.task.input, signal()); const r = await f.handoff.complete(f.task, signal());
  const key = part === "image" ? f.task.input.selection.image.objectKey : part === "response" ? r.result.objectKey : r.completion.objectKey;
  f.remote.data.set(key, Buffer.from("corrupt")); const writes = f.remote.writes;
  await expect(f.handoff.inspect(f.task, signal())).rejects.toThrow();
  expect(f.remote.writes).toBe(writes); expect(f.provider.interpret).toHaveBeenCalledOnce();
});
it("protocol removal, config changes and record relabelling cannot reuse a registered operation", async () => {
  const f = labelExecutionFixture(); await f.module.run(f.task.input, signal()); const r = await f.handoff.complete(f.task, signal());
  const { extractionProtocol, ...input } = f.task.input;
  await expect(f.handoff.inspect({ ...f.task, input }, signal())).rejects.toThrow("VISION.RESULT_CONFLICT");
  await expect(f.handoff.inspect({ ...f.task, configFingerprint: "b".repeat(64) }, signal())).rejects.toThrow("VISION.RESULT_CONFLICT");
  expect(() => VisionRecordSchema.parse({ ...r, codec: "vision-result/1" })).toThrow();
  expect(() => VisionRecordSchema.parse({ ...r, result: { ...r.result, producer: { ...r.result.producer, implementationVersion: "vision/1" } } })).toThrow();
  const changed = new VisionModule({ ...f.dependencies, provider: { ...f.provider, fingerprint: "b".repeat(64) } });
  expect(await changed.run(f.task.input, signal())).toMatchObject({ code: "VISION.INPUT_CONFLICT" });
  expect(f.provider.interpret).toHaveBeenCalledOnce();
});
it("lost registration acknowledgement is recovered by inspection only", async () => {
  const f = labelExecutionFixture(); await f.module.run(f.task.input, signal()); const register = f.registry.register;
  f.registry.register = async r => { await register(r); throw Error("ack lost"); };
  await expect(f.handoff.complete(f.task, signal())).rejects.toThrow("ack lost");
  const writes = f.remote.writes; f.local.data.clear();
  expect(await f.handoff.inspect(f.task, signal())).toMatchObject({ codec: "vision-result/2" });
  expect(f.remote.writes).toBe(writes); expect(f.provider.interpret).toHaveBeenCalledOnce();
});
it("unpublished raw response retains computed evidence and never auto uploads or reruns", async () => {
  const f = labelExecutionFixture(), create = f.remote.create.bind(f.remote); let attempts = 0;
  f.remote.create = async (k, b) => { if (k.endsWith("response.json")) { attempts++; throw Error("offline"); } return create(k, b); };
  expect(await f.module.run(f.task.input, signal())).toMatchObject({ code: "VISION.HANDOFF_PENDING", candidate: gncLabelFixture() });
  expect(await f.module.run(f.task.input, signal())).toMatchObject({ code: "VISION.HANDOFF_PENDING", replayed: true });
  expect(attempts).toBe(1); expect(f.provider.interpret).toHaveBeenCalledOnce(); expect(f.records.size).toBe(0);
});
it("v2 registration survives JSONB key ordering and retains hash integrity", async () => {
  const f = labelExecutionFixture(); await f.module.run(f.task.input, signal()); const r = await f.handoff.complete(f.task, signal());
  let row: Record<string, unknown> | undefined;
  const reorder = (v: unknown): unknown => Array.isArray(v) ? v.map(reorder) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v;
  const registry = new PostgresVisionRegistry({ query: async (sql, args) => {
    if (sql.startsWith("INSERT")) row ??= { record: reorder(JSON.parse(args![2] as string)), record_hash: args![1] };
    return { rows: row ? [row] : [] };
  } });
  await registry.register(r); expect(await registry.read(r.input.operationId)).toEqual(r);
  row!.record_hash = "f".repeat(64); await expect(registry.read(r.input.operationId)).rejects.toThrow("VISION.RESULT_INTEGRITY");
});
