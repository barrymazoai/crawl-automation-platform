import { expect, it } from "vitest";
import { LabelCollectedProductSchema, TextCandidateV3Schema, TextRecordSchema, TextInputSchema, textFingerprint } from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/v3-artifacts";
import { gncLabelFixture } from "../../v3-contracts/src/label.fixture.js";
import { labelExecutionFixture as textFixture } from "../../v3-text/src/label-execution.fixture.js";
import { labelProductFixture } from "./label-product.fixture.js";
import { mergeLabelProduct, type VerifiedLabelSource } from "./label-merge.js";
const signal = () => new AbortController().signal;

/** Synthetic verified-reader boundary; no network or model invocation. */
async function fixture(images = [gncLabelFixture()], text = gncLabelFixture()) {
  const f = await labelProductFixture(images), owner = f.join.manifest.observation;
  let fullText = "";
  const quote = (value: any): any => {
    if (Array.isArray(value)) return value.map(quote);
    if (!value || typeof value !== "object") return value;
    if ("text" in value && "evidence" in value) {
      const start = fullText.length; fullText += value.text + "\n";
      return { text: value.text, start, end: start + value.text.length };
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, quote(v)]));
  };
  const candidate = TextCandidateV3Schema.parse({ ...quote(text), schemaVersion: 3 });
  const base = textFixture().input;
  if (base.source.kind !== "prepared") throw Error();
  const { observationId, sourceId, listingId, variantId } = owner;
  const document = { ...base.source.document, observationId, sourceId, listingId, variantId };
  const unsigned = { ...base, ...owner, source: { kind: "prepared" as const, document }, range: { start: 0, end: fullText.length } };
  const task = TextInputSchema.parse({ ...unsigned, inputFingerprint: textFingerprint(unsigned, s => sha256(Buffer.from(s))) });
  const ref = (suffix: string) => ({ ...document, artifactId: `text-${suffix}`, objectKey: `synthetic-text/${suffix}.json`,
    producer: { module: task.module, operationId: task.operationId, implementationVersion: task.implementationVersion } });
  const record = TextRecordSchema.parse({ schemaVersion: 1, storageId: "synthetic/1", input: task, result: ref("result"), completion: ref("completion") });
  const entry = { id: "a-text", kind: "text" as const, record, candidate, fullText };
  const readImage = f.deps.readSource.getMockImplementation()!;
  // The production readers verify retained bytes. This fake isolates merge/collection policy tests.
  const read = async (s: typeof f.join.manifest.sources[number], abort: AbortSignal): Promise<VerifiedLabelSource> =>
    s.kind === "text" ? structuredClone(entry) : readImage(s, abort);
  f.deps.readSource.mockImplementation(read as any);
  f.join.manifest.sources.push({ id: entry.id, kind: "text", required: true, task });
  f.join.states.push({ id: entry.id, status: "registered" });
  f.join.manifest.evidencePolicy = "label-image-first/1";
  const entries = await Promise.all(f.join.manifest.sources.map(s => read(s, signal())));
  return { ...f, entries, text: entry };
}
const b12Text = () => { const c = gncLabelFixture(), r = c.formula!.columns[0]!.rows[17]!; r.kind = "nutrient"; r.parentRowIndex = null; return c; };

it("v4 blocks exact nutrient numeric disagreement instead of trusting complete=true",async()=>{
 const image=gncLabelFixture(), text=gncLabelFixture();const r=text.formula!.columns[0]!.rows[1]!;r.amount!.text="999 g";
 const f=await fixture([image],text);f.join.manifest.evidencePolicy="label-image-first/4";
 expect(mergeLabelProduct(f.join.manifest,f.entries).codes).toContain("LABEL_PRODUCT.SOURCE_NUMERIC_CONFLICT");
 f.join.manifest.evidencePolicy="label-image-first/3";const out=await f.assembly.run(f.join,signal());expect(out.status).toBe("ready");
 expect((await f.collector.run({join:f.join,evidenceKey:out.evidenceKey},signal())).status).toBe("collected");
 expect(LabelCollectedProductSchema.safeParse({...f.collected.values().next().value,evidencePolicy:"label-image-first/4"}).success).toBe(false);
});
it("v4 keeps image grouping priority for B12, not all text differences are blockers",async()=>{
 const f=await fixture([gncLabelFixture()],b12Text());f.join.manifest.evidencePolicy="label-image-first/4";
 expect(mergeLabelProduct(f.join.manifest,f.entries).status).toBe("ready");
});
it("v4 excludes verifiably defective old image and persists complete text fallback",async()=>{
 const c=gncLabelFixture();const rows=c.formula!.columns[0]!.rows,parent=rows[4]!;parent.kind="blend_total";parent.amount={text:"100 mg",evidence:"100 mg"};parent.amountStatus="printed";const r=rows[5]!;
 r.name.evidence="90% "+r.name.text;r.amount=null;r.amountStatus="not_declared";
 const f=await fixture([c]);f.join.manifest.evidencePolicy="label-image-first/4";
 const out=await f.assembly.run(f.join,signal());expect(out.status).toBe("ready");
 const input={join:f.join,evidenceKey:out.evidenceKey};expect((await f.collector.run(input,signal())).status).toBe("collected");
 const record=[...f.collected.values()][0]!;expect(record.formula.servingSize!.citation.kind).toBe("text");expect(record.provenance).toHaveLength(2);
 expect((await f.cold().collector.run(input,signal())).status).toBe("collected");
});

it("image wins B12 grouping, warns on text, persists both originals and survives cold readback", async () => {
  const f = await fixture([gncLabelFixture()], b12Text());
  const old = structuredClone(f.join.manifest); delete old.evidencePolicy;
  expect(mergeLabelProduct(old, f.entries).codes).toContain("LABEL_PRODUCT.FORMULA_CONFLICT");
  const out = await f.assembly.run(f.join, signal()); expect(out.status).toBe("ready");
  const input = { join: f.join, evidenceKey: out.evidenceKey };
  expect((await f.collector.run(input, signal())).status).toBe("collected");
  const record = [...f.collected.values()][0]!;
  expect(record.evidencePolicy).toBe("label-image-first/1");
  expect(record.formula.columns[0]!.rows[17]).toMatchObject({ kind: "blend_component", parentRowIndex: 13, name: { citation: { kind: "image" } } });
  expect(record.warnings).toContainEqual({ id: "a-text", code: "LABEL_PRODUCT.SECONDARY_TEXT_FORMULA_CONFLICT" });
  expect(record.provenance).toHaveLength(2);
  expect(LabelCollectedProductSchema.safeParse({ ...record, warnings: [] }).success).toBe(false);
  expect(record.provenance.find(p => p.kind === "text")!.candidate.formula!.columns[0]!.rows[17]!.kind).toBe("nutrient");
  expect((await f.cold().collector.run(input, signal())).status).toBe("collected");
  expect(f.registry.append).toHaveBeenCalledTimes(1);
});
it("entry order cannot change the chosen image", async () => {
  const f = await fixture([gncLabelFixture()], b12Text());
  expect(mergeLabelProduct(f.join.manifest, f.entries)).toEqual(mergeLabelProduct({ ...f.join.manifest, sources: [...f.join.manifest.sources].reverse() }, [...f.entries].reverse()));
});
it("v2 complete image permits verified executed secondary text quality failure, v1 does not",async()=>{
  const f=await fixture(),failure={id:"a-text",code:"TEXT.LABEL_GROUP_EMPTY",verifiedExecuted:true};
  expect(mergeLabelProduct(f.join.manifest,[f.entries[0]!],[failure]).status).toBe("review");
  f.join.manifest.evidencePolicy="label-image-first/2";
  const result=mergeLabelProduct(f.join.manifest,[f.entries[0]!],[failure]);
  expect(result.status).toBe("ready");expect(result.warnings).toContainEqual({id:"a-text",code:"TEXT.LABEL_GROUP_EMPTY"});
  expect(result.formula!.servingSize!.citation.kind).toBe("image");
});
it("v2 collection retains the reviewed source in assembly and survives cold readback",async()=>{
  const f=await fixture(),task=f.text.record.input;f.join.manifest.evidencePolicy="label-image-first/2";
  const review:any={schemaVersion:1,reviewId:"text-quality-review",occurredAt:"2026-09-10T00:00:00Z",observation:f.join.manifest.observation,
    failure:{schemaVersion:1,requestId:task.requestId,observationId:task.observationId,operationId:task.operationId,inputFingerprint:task.inputFingerprint,stage:"codex.text",category:"PROCESSING",code:"TEXT.LABEL_GROUP_EMPTY",executionFact:"executed",evidenceKey:"text-intents/original.json",blockedBy:null,automaticRetry:false},
    rawError:{name:"quality",message:"TEXT.LABEL_GROUP_EMPTY",stack:null,details:{}},candidate:null,inspection:{kind:"none"}};
  f.records.set(review.reviewId,review);f.join.states=f.join.states.map(s=>s.id==="a-text"?{id:s.id,status:"review",reviewId:review.reviewId}:s);
  const out=await f.assembly.run(f.join,signal());expect(out.status).toBe("ready");
  const input={join:f.join,evidenceKey:out.evidenceKey};expect((await f.collector.run(input,signal())).status).toBe("collected");
  const record=[...f.collected.values()][0]!;expect(record.evidencePolicy).toBe("label-image-first/2");expect(record.warnings).toContainEqual({id:"a-text",code:"TEXT.LABEL_GROUP_EMPTY"});
  expect(f.records.get(review.reviewId)).toEqual(review);expect((await f.cold().collector.run(input,signal())).status).toBe("collected");
});
it.each(["unconfirmed","no-complete-image","identity","missing-receipt"])("v2 still blocks %s",async mode=>{
  const f=await fixture();f.join.manifest.evidencePolicy="label-image-first/2";
  const failure={id:"a-text",code:"TEXT.LABEL_GROUP_EMPTY",verifiedExecuted:mode!=="unconfirmed"};
  if(mode==="identity")failure.code="TEXT.SOURCE_CONFLICT";
  if(mode==="missing-receipt")failure.code="TEXT_RECEIPT.TEXT_UNCONFIRMED";
  if(mode==="no-complete-image")f.entries[0]!.candidate.ingredientsComplete=false;
  expect(mergeLabelProduct(f.join.manifest,[f.entries[0]!],[failure]).status).toBe("review");
});
it("v2 cold Review readback returns one durable receipt without duplicate Reviews",async()=>{
  const f=await fixture();f.join.manifest.evidencePolicy="label-image-first/2";
  f.join.states=f.join.states.map(s=>({id:s.id,status:"unresolved"}));
  f.deps.readSource.mockRejectedValue(Error("unavailable"));
  const first=await f.assembly.run(f.join,signal()),writes=f.remote.writes;
  expect(first.status).toBe("review");expect(f.records.size).toBe(1);
  expect(await f.cold().assembly.run(f.join,signal())).toEqual(first);
  expect(f.records.size).toBe(1);expect(f.remote.writes).toBe(writes);
});
it("changing source ID ordering does not grant text priority", async () => {
  const f = await fixture([gncLabelFixture()], b12Text());
  const image = f.entries[0]!; image.id = "a-image"; f.join.manifest.sources[0]!.id = image.id;
  f.entries[1]!.id = "z-text"; f.join.manifest.sources[1]!.id = "z-text";
  const out = mergeLabelProduct(f.join.manifest, f.entries);
  expect(out.status).toBe("ready"); expect(out.formula!.servingSize!.sourceId).toBe("a-image");
});
it("text Ingredients difference is retained as a warning, never merged into the image", async () => {
  const text = gncLabelFixture(); text.otherIngredients!.items[0]!.text = "Different syrup";
  const f = await fixture([gncLabelFixture()], text), out = mergeLabelProduct(f.join.manifest, f.entries);
  expect(out.status).toBe("ready"); expect(out.otherIngredients!.items[0]!.text).toBe("Malt Syrup");
  expect(out.warnings).toContainEqual({ id: "a-text", code: "LABEL_PRODUCT.SECONDARY_TEXT_INGREDIENTS_CONFLICT" });
});
it.each(["amount", "ingredients", "group"])("conflicting images still block %s", async kind => {
  const c = gncLabelFixture();
  if (kind === "amount") c.formula!.columns[0]!.rows[5]!.amount!.text = "201 mg";
  if (kind === "ingredients") c.otherIngredients!.items[0]!.text = "Different syrup";
  if (kind === "group") { c.formula!.columns[0]!.rows[17]!.kind = "nutrient"; c.formula!.columns[0]!.rows[17]!.parentRowIndex = null; }
  const f = await fixture([gncLabelFixture(), c]);
  expect(mergeLabelProduct(f.join.manifest, f.entries).status).toBe("review");
});
it("required incomplete image does not acquire priority or silently pass", async () => {
  const f = await fixture(), image = f.entries.find(e => e.kind === "image")!;
  image.candidate.formulaComplete = false;
  const out = mergeLabelProduct(f.join.manifest, f.entries);
  expect(out.status).toBe("review"); expect(out.codes).toContain("LABEL.FORMULA_INCOMPLETE");
  expect(out.formula!.servingSize!.citation.kind).toBe("text");
});
it("no image falls back to existing complete text admission", async () => {
  const f = await fixture(); f.join.manifest.sources = f.join.manifest.sources.filter(s => s.kind === "text");
  const out = mergeLabelProduct(f.join.manifest, [f.text]);
  expect(out.status).toBe("ready"); expect(out.formula!.servingSize!.citation.kind).toBe("text");
});
it.each(["identity", "citation", "barrier", "failure"])("image priority never bypasses %s verification", async kind => {
  const f = await fixture();
  if (kind === "identity") { f.text.record.input.operationId = "foreign"; expect(() => mergeLabelProduct(f.join.manifest, [f.entries[0]!, f.text])).toThrow(); }
  if (kind === "citation") { f.text.candidate.formula!.servingSize!.start++; expect(() => mergeLabelProduct(f.join.manifest, [f.entries[0]!, f.text])).toThrow("TEXT.CITATION_INVALID"); }
  if (kind === "barrier") expect(mergeLabelProduct(f.join.manifest, [f.entries[0]!]).codes).toContain("LABEL_PRODUCT.BARRIER_INCOMPLETE");
  if (kind === "failure") expect(mergeLabelProduct(f.join.manifest, [f.entries[0]!], [{ id: "a-text", code: "LABEL_PRODUCT.EVIDENCE_UNRESOLVED" }]).status).toBe("review");
});
it("persisted record cannot claim image priority while choosing text", async () => {
  const f = await fixture([gncLabelFixture()], b12Text()); delete f.join.manifest.evidencePolicy;
  // Build a legitimately text-only record first, then attach a contradictory authoritative image.
  f.join.manifest.sources = f.join.manifest.sources.filter(s => s.kind === "text"); f.join.states = f.join.states.filter(s => s.id === "a-text");
  const out = await f.assembly.run(f.join, signal()); await f.collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal());
  const record = structuredClone([...f.collected.values()][0]!);
  record.evidencePolicy = "label-image-first/1";
  const image = f.entries[0]!; if (image.kind !== "image") throw Error(); record.provenance.push(image);
  expect(LabelCollectedProductSchema.safeParse(record).success).toBe(false);
});
it("v3 complete text can collect with a verified executed incomplete-image Review, v2 remains blocked",async()=>{
  const f=await fixture(),source=f.join.manifest.sources.find(s=>s.kind==="image")!;
  if(source.kind!=="image")throw Error();
  const {visionFingerprint}=await import("@crawl-automation/v3-vision");
  const review:any={schemaVersion:1,reviewId:"incomplete-image-review",occurredAt:"2026-09-10T00:00:00Z",observation:f.join.manifest.observation,
    failure:{schemaVersion:1,requestId:f.join.manifest.observation.requestId,observationId:f.join.manifest.observation.observationId,
      operationId:source.task.input.operationId,inputFingerprint:visionFingerprint(source.task),stage:"codex.vision",category:"PROCESSING",code:"VISION.LABEL_INGREDIENTS_INCOMPLETE",executionFact:"executed",evidenceKey:"retained/image-response.json",blockedBy:null,automaticRetry:false},
    rawError:{name:"quality",message:"VISION.LABEL_INGREDIENTS_INCOMPLETE",stack:null,details:{}},candidate:null,inspection:{kind:"none"}};
  f.records.set(review.reviewId,review);f.join.states=f.join.states.map(s=>s.id===source.id?{id:s.id,status:"review",reviewId:review.reviewId}:s);
  expect(mergeLabelProduct({...f.join.manifest,evidencePolicy:"label-image-first/2"},[f.text],[{id:source.id,code:review.failure.code,verifiedExecuted:true}]).status).toBe("review");
  f.join.manifest.evidencePolicy="label-image-first/3";
  const out=await f.assembly.run(f.join,signal());expect(out.status).toBe("ready");
  const input={join:f.join,evidenceKey:out.evidenceKey};expect((await f.collector.run(input,signal())).status).toBe("collected");
  const product=[...f.collected.values()][0]!;expect(product.formula.servingSize!.citation.kind).toBe("text");
  expect(product.warnings).toContainEqual({id:source.id,code:review.failure.code});
  expect(await f.cold().collector.run(input,signal())).toMatchObject({status:"collected"});expect(f.collected.size).toBe(1);
});
it.each(["unknown","identity","missing-receipt","incomplete-text"])("v3 fallback still rejects %s",async kind=>{
  const f=await fixture();f.join.manifest.evidencePolicy="label-image-first/3";
  const failure={id:f.entries[0]!.id,code:"VISION.LABEL_INGREDIENTS_INCOMPLETE",verifiedExecuted:kind!=="unknown"};
  if(kind==="identity")failure.code="VISION.INPUT_CONFLICT";
  if(kind==="missing-receipt")failure.code="VISION.HANDOFF_PENDING";
  if(kind==="incomplete-text")f.text.candidate.ingredientsComplete=false;
  expect(mergeLabelProduct(f.join.manifest,[f.text],[failure]).status).toBe("review");
});
it("v3 complete images retain priority and conflicting complete images still block",async()=>{
  const f=await fixture([gncLabelFixture()],b12Text());f.join.manifest.evidencePolicy="label-image-first/3";
  const result=mergeLabelProduct(f.join.manifest,f.entries);expect(result.status).toBe("ready");expect(result.formula!.servingSize!.citation.kind).toBe("image");
  const c=gncLabelFixture();c.formula!.columns[0]!.rows[0]!.amount!.text="999";
  const g=await fixture([gncLabelFixture(),c]);g.join.manifest.evidencePolicy="label-image-first/3";
  expect(mergeLabelProduct(g.join.manifest,g.entries).status).toBe("review");
});
