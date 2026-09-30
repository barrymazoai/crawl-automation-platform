import { afterEach, expect, it, vi } from "vitest";
import { TextDocumentSchema, parseTextInput, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { pageInput, sign } from "./testing.fixture.js";
import { PageEvidence, PreparePageModule, PreparePageText, pageCompletionKey } from "./page-handoff.js";
import * as parser from "./page.js";
import { hash } from "./core.js";
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());
function fixture(html = '<p>Other ingredients: water</p><table><tr><td colspan="2">10 mg</td></tr></table>') {
  const f = pageInput(html), local = new MemoryObjects(), remote = new MemoryObjects(), records = new Map<string, ReviewRecord>();
  remote.data.set(f.input.page.objectKey, f.bytes);
  const reviews = { read: async (id: string) => records.get(id) ?? null, append: async (r: ReviewRecord) => { records.set(r.reviewId, r); } };
  const deps = { local, remote, reviews }, evidence = new PageEvidence(deps);
  const plan = { page: f.input, textOperationId: "text-op-1", text: { schemaVersion: 1 as const, module: "codex.text" as const,
    implementationVersion: "codex-text/2", policyVersion: "anchored/2", resultSchemaVersion: 2 as const, configFingerprint: "b".repeat(64) } };
  return { ...f, ...deps, records, plan, evidence, module: new PreparePageModule(evidence), prepare: new PreparePageText(evidence) };
}
it("publishes full document and table evidence, then signed V2 text input without parsing again", async () => {
  const f = fixture(), spy = vi.spyOn(parser, "preparePage");
  const receipt = await f.module.run(f.input, signal());
  if (receipt.status !== "durable") throw Error(JSON.stringify(receipt));
  const doc = TextDocumentSchema.parse(JSON.parse(Buffer.from(f.remote.data.get(receipt.record.document.objectKey)!).toString()));
  expect(doc.source).toEqual(f.input.page); expect(doc.text).toBe("Other ingredients: water\n\n10 mg");
  expect(JSON.parse(Buffer.from(f.remote.data.get(receipt.record.tables.objectKey)!).toString())[0].rows[0][0].colspan).toBe(2);
  const task = await f.prepare.run({ plan: f.plan, receipt }, signal());
  if (task.status !== "prepared") throw Error();
  expect(parseTextInput(task.task, hash).range).toEqual({ start: 0, end: doc.text.length });
  expect(spy).toHaveBeenCalledTimes(1);
  const before = f.remote.writes, next = new PageEvidence({ local: new MemoryObjects(), remote: f.remote, reviews: f.reviews });
  expect(await new PreparePageModule(next).run(f.input, signal())).toEqual(receipt);
  expect(await new PreparePageText(next).run({ plan: f.plan, receipt: null }, signal())).toEqual(task);
  expect(f.remote.writes).toBe(before); expect(spy).toHaveBeenCalledTimes(1);
});
it("empty/oversized text enters Review without truncation, scripts or network loads", async () => {
  for (const [html, code] of [["<script>fetch('https://example.test')</script>", "PROCESSING.PAGE_EMPTY"], ["x".repeat(200001), "PAGE.TEXT_LIMIT"]]) {
    const f = fixture(html), result = await f.module.run(f.input, signal());
    expect(result).toMatchObject({ status: "review", code });
    expect(f.remote.data.has(pageCompletionKey(f.input))).toBe(false);
    expect(f.remote.data.get(f.input.page.objectKey)).toEqual(f.bytes);
  }
});
it("invalid UTF-8, corrupted source, missing source and bad fingerprint cannot publish success", async () => {
  const utf = fixture(); const bytes = Buffer.from([0xff, 0xfe]);
  utf.input = sign({ ...utf.input, page: { ...utf.input.page, sha256: hash(bytes), byteSize: bytes.length } });
  utf.remote.data.set(utf.input.page.objectKey, bytes);
  expect(await utf.module.run(utf.input, signal())).toMatchObject({ code: "ARTIFACT.MEDIA_TYPE" });
  const f = fixture(); f.remote.data.set(f.input.page.objectKey, Buffer.from("bad"));
  expect(await f.module.run(f.input, signal())).toMatchObject({ code: "ARTIFACT.INTEGRITY" });
  f.remote.data.clear(); expect(await f.module.run(f.input, signal())).toMatchObject({ code: "PAGE.SOURCE_NOT_DURABLE" });
  expect(await f.module.run({ ...f.input, inputFingerprint: "b".repeat(64) }, signal())).toMatchObject({ code: "INPUT.FINGERPRINT_MISMATCH" });
});
it("publication failure retains candidates and replacement neither reparses nor retries data upload", async () => {
  const f = fixture(), spy = vi.spyOn(parser, "preparePage"), create = f.remote.create.bind(f.remote); let dataPuts = 0;
  vi.spyOn(f.remote, "create").mockImplementation(async (key, bytes) => {
    if (key.endsWith("/document.json")) { dataPuts++; throw Error("synthetic unavailable"); }
    return create(key, bytes);
  });
  expect(await f.module.run(f.input, signal())).toMatchObject({ code: "PAGE.HANDOFF_UNVERIFIED" });
  expect(f.local.data.has(pageCompletionKey(f.input))).toBe(true);
  const next = new PageEvidence({ local: new MemoryObjects(), remote: f.remote, reviews: f.reviews });
  expect(await new PreparePageModule(next).run(f.input, signal())).toMatchObject({ code: "PAGE.EXECUTION_UNKNOWN" });
  expect(await new PreparePageText(next).run({ plan: f.plan, receipt: null }, signal())).toMatchObject({ code: "PAGE.NOT_DURABLE" });
  expect(spy).toHaveBeenCalledTimes(1); expect(dataPuts).toBe(1);
});
it("prepared input upload unknown cannot be retried from an empty-cache node", async () => {
  const f = fixture(), receipt = await f.module.run(f.input, signal()), create = f.remote.create.bind(f.remote); let puts = 0;
  vi.spyOn(f.remote, "create").mockImplementation(async (key, bytes) => {
    if (key.startsWith("v3/page-text-inputs/")) { puts++; throw Error("synthetic unavailable"); } return create(key, bytes);
  });
  expect(await f.prepare.run({ plan: f.plan, receipt }, signal())).toMatchObject({ code: "PAGE.HANDOFF_UNVERIFIED" });
  const next = new PreparePageText(new PageEvidence({ local: new MemoryObjects(), remote: f.remote, reviews: f.reviews }));
  expect(await next.run({ plan: f.plan, receipt: null }, signal())).toMatchObject({ code: "PAGE.HANDOFF_PENDING" });
  expect(puts).toBe(1);
});
it("lost completion PUT acknowledgment recovers by GET only", async () => {
  const f = fixture(), create = f.remote.create.bind(f.remote); let puts = 0;
  vi.spyOn(f.remote, "create").mockImplementation(async (key, bytes) => {
    const result = await create(key, bytes);
    if (key === pageCompletionKey(f.input)) { puts++; throw Error("lost"); } return result;
  });
  expect(await f.module.run(f.input, signal())).toMatchObject({ status: "durable" }); expect(puts).toBe(1);
});
it("explicit Review is reused, forged identity rejected and corrupt tables never reach text", async () => {
  const bad = fixture("<script>no text</script>"), receipt = await bad.module.run(bad.input, signal());
  expect(await bad.prepare.run({ plan: bad.plan, receipt }, signal())).toEqual(receipt); expect(bad.records.size).toBe(1);
  if (receipt.status !== "review") throw Error();
  expect(await bad.prepare.run({ plan: bad.plan, receipt: { ...receipt, operationId: "foreign" } }, signal())).toMatchObject({ code: "PAGE.IDENTITY_CONFLICT" });
  const f = fixture(), good = await f.module.run(f.input, signal()); if (good.status !== "durable") throw Error();
  f.remote.data.set(good.record.tables.objectKey, Buffer.from("[]"));
  expect(await f.prepare.run({ plan: f.plan, receipt: good }, signal())).toMatchObject({ status: "review", code: "ARTIFACT.INTEGRITY" });
});
it("Review must be confirmed; retained local evidence does not pretend database success", async () => {
  const f = fixture(); f.remote.data.clear();
  f.reviews.append = async () => { throw Error("synthetic private connection"); };
  await expect(f.module.run(f.input, signal())).rejects.toThrow("PAGE.REVIEW_UNVERIFIED");
  expect([...f.local.data.keys()].some(k => k.startsWith("page-reviews/"))).toBe(true);
});
