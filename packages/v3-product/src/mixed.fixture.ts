import { fixture, signal } from "../../v3-text/src/testing.fixture.js";
import { TextModule } from "../../v3-text/src/module.js";
import { textFingerprint, type ProductEvidenceJoin, type VisionRecord, type TextCandidate } from "@crawl-automation/v3-contracts";
import { digest, screenKeywords, VisionModule, VisionHandoff } from "@crawl-automation/v3-vision";
import { candidate, image, bytes } from "../../v3-vision/src/testing.fixture.js";
import { ProductEvidenceAssembly } from "./mixed-assembly.js";
import type { VerifiedProductEvidence } from "./mixed-merge.js";
export async function mixedFixture() {
  const f = fixture("Other ingredients: Water"), compatibility = { ...f.provider.supported, implementationVersion: "codex-text/2", policyVersion: "anchored/2", resultSchemaVersion: 2 as const };
  const task = { ...f.input, ...compatibility }; task.inputFingerprint = textFingerprint(task, digest);
  let textCalls = 0, visionCalls = 0;
  const provider = { ...f.provider, supported: compatibility, interpret: async () => { textCalls++; return JSON.stringify({ formula: null,
    ingredients: { items: [{ quote: { fromLine: 1, toLine: 1, text: "Water" }, role: "other", parentNutrientIndex: null }] },
    excluded: [{ quote: { fromLine: 1, toLine: 1, text: "Other ingredients:" }, reason: "heading" }], issues: [] }); } };
  const receipt = await new TextModule({ ...f.deps, provider }).run(task, signal());
  if (receipt.status !== "registered") throw Error(JSON.stringify(receipt));
  const picture = { ...image, observationId: f.owner.observationId, sourceId: f.owner.sourceId, listingId: f.owner.listingId, variantId: f.owner.variantId };
  f.remote.data.set(picture.objectKey, bytes);
  const selected = screenKeywords({ observation: f.owner, image: picture, ocrOperationId: "ocr-1", text: "Supplement Facts" });
  const visionTask = { input: { operationId: "vision-1", selection: selected }, configFingerprint: "a".repeat(64) };
  const records = new Map<string, VisionRecord>(), vision = new VisionHandoff(f.local, f.remote, {
    read: async id => records.get(id) ?? null, register: async r => { records.set(r.input.operationId, r); },
  }, "fixture/1", async () => {});
  await new VisionModule({ provider: { fingerprint: visionTask.configFingerprint, interpret: async () => { visionCalls++; return JSON.stringify(candidate); } },
    localEvidence: f.local, store: f.remote, verifiedOcrText: async () => "Supplement Facts", resolve: async () => bytes }).run(visionTask.input, signal());
  await vision.complete(visionTask, signal());
  const text = { readCandidate: async () => {
    const facts = await f.handoff.inspect(task, signal()); if (!facts.record || !facts.artifactDurable || !facts.resultRegistered) throw Error();
    const result = JSON.parse(Buffer.from(f.remote.data.get(facts.record.result.objectKey)!).toString());
    return { record: facts.record, candidate: result.candidate as TextCandidate, fullText: f.text };
  } };
  const join: ProductEvidenceJoin = { manifest: { operationId: "mixed-1", observation: f.owner, sources: [
    { id: "text", kind: "text", required: true, task }, { id: "image", kind: "image", required: true, task: visionTask },
  ] }, states: [{ id: "text", status: "registered" }, { id: "image", status: "registered" }] };
  const entries: VerifiedProductEvidence[] = [{ id: "text", kind: "text", ...await text.readCandidate() }, { id: "image", kind: "image", ...await vision.readCandidate(visionTask, signal()) }];
  const deps = { local: f.local, remote: f.remote, reviews: f.reviews, text, vision };
  return { ...f, task, visionTask, join, entries, deps, service: new ProductEvidenceAssembly(deps), calls: () => [textCalls, visionCalls] };
}
