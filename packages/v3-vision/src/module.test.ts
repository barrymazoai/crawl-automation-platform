import { expect, it } from "vitest";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { VisionModule } from "./module.js";
import { validateVision } from "./extraction.js";
import { bytes, candidate, selection } from "./testing.fixture.js";
function fixture(raw = JSON.stringify(candidate)) {
  const data = new Map<string, Uint8Array>(); let calls = 0;
  const store: ObjectStore = { async read(key) { return data.get(key) ?? null; },
    async create(key, value) { if (data.has(key)) return "exists"; data.set(key, value); return "created"; } };
  const deps = { store, localEvidence: store, provider: { fingerprint: "fixed", async interpret() { calls++; return raw; } },
    async resolve() { return bytes; }, async verifiedOcrText() { return "Supplement Facts"; } };
  return { data, deps, module: new VisionModule(deps), calls: () => calls, input: { operationId: "vision-1", selection: selection() } };
}
const signal = () => new AbortController().signal;
it("rejects nonmatched images without a model call", async () => {
  const f = fixture(); await expect(f.module.run({ ...f.input, selection: selection("hello") }, signal())).rejects.toThrow();
  expect(f.calls()).toBe(0);
});
it("does not call a model on upstream OCR failure", async () => {
  const f = fixture(); f.deps.verifiedOcrText = async () => { throw Error("OCR unavailable"); };
  await expect(f.module.run(f.input, signal())).rejects.toThrow(); expect(f.calls()).toBe(0);
});
it("saves raw evidence and replays without re-executing after a new module instance", async () => {
  const f = fixture(); const r = await f.module.run(f.input, signal());
  expect(r).toMatchObject({ status: "candidate", replayed: false, automaticRetry: false });
  expect(await new VisionModule(f.deps).run(f.input, signal())).toMatchObject({ ...r, replayed: true });
  expect(f.calls()).toBe(1);
});
it("concurrent duplicate operations get at most one external execution", async () => {
  const f = fixture(); await Promise.all([f.module.run(f.input, signal()), f.module.run(f.input, signal())]);
  expect(f.calls()).toBe(1);
});
it("configuration changes with the same operation cannot create another execution", async () => {
  const f = fixture(); await f.module.run(f.input, signal()); f.deps.provider.fingerprint = "changed";
  expect(await f.module.run(f.input, signal())).toMatchObject({ status: "review", code: "VISION.INPUT_CONFLICT" }); expect(f.calls()).toBe(1);
});
it("a missing response behind an existing intent is unknown, never retried", async () => {
  const f = fixture(); await f.module.run(f.input, signal()); f.data.delete("v3/vision/vision-1/response.json");
  expect(await f.module.run(f.input, signal())).toMatchObject({ code: "VISION.EXECUTION_UNKNOWN" }); expect(f.calls()).toBe(1);
});
it("keeps invalid output as passive review evidence", async () => {
  const f = fixture("invalid JSON"); expect(await f.module.run(f.input, signal())).toMatchObject({ status: "review", code: "VISION.INVALID_OUTPUT" });
  expect(f.data.has("v3/vision/vision-1/response.json")).toBe(true);
});
it("integrity failure prevents model execution", async () => {
  const f = fixture(); f.deps.resolve = async () => Buffer.from("changed");
  await expect(f.module.run(f.input, signal())).rejects.toThrow(); expect(f.calls()).toBe(0);
});
it("tampered persisted raw output cannot be replayed", async () => {
  const f = fixture(); await f.module.run(f.input, signal()); const key = "v3/vision/vision-1/response.json";
  const saved = JSON.parse(Buffer.from(f.data.get(key)!).toString()); saved.raw = "tampered";
  f.data.set(key, Buffer.from(JSON.stringify(saved))); await expect(f.module.run(f.input, signal())).rejects.toThrow("VISION.EVIDENCE_CONFLICT"); expect(f.calls()).toBe(1);
});
it("accepts image text absent from OCR without using text offsets", () => {
  expect(validateVision(JSON.stringify(candidate)).status).toBe("candidate");
});
it("preserves dosage columns and rejects invalid blend parents", () => {
  expect(validateVision(JSON.stringify({ ...candidate, ingredients: [{ ...candidate.ingredients[0], parentBlend: "wrong" }] })).code).toBe("VISION.ROLE_INVALID");
});
it("incomplete or uncertain visual evidence stays in Review", () => {
  expect(validateVision(JSON.stringify({ ...candidate, formulaComplete: false })).code).toBe("VISION.CORE_MISSING");
  expect(validateVision(JSON.stringify({ ...candidate, issues: [{ code: "UNREADABLE", detail: "small print" }] })).code).toBe("VISION.EVIDENCE_UNCERTAIN");
});
it("keeps a formula-only selected image as partial evidence for the product join", () => {
  expect(validateVision(JSON.stringify({ ...candidate, ingredients: [], ingredientsComplete: false,
    issues: [{ code: "INGREDIENTS_MISSING", detail: "ingredients on another image" }] })).status).toBe("partial");
});
it("keeps an ingredients-only selected image without pretending the whole product is missing", () => {
  expect(validateVision(JSON.stringify({ ...candidate, formula: null, formulaComplete: false,
    ingredients: [{ name: "Cellulose", evidence: "Cellulose", role: "other", parentBlend: null }],
    issues: [{ code: "FORMULA_MISSING", detail: "no facts table in this image" }] })).status).toBe("partial");
});
it("remote upload failure retains local raw evidence; redelivery never re-executes or auto-uploads", async () => {
  const f = fixture(), local = new Map<string, Uint8Array>(); let failedPuts = 0;
  f.deps.localEvidence = { async read(k) { return local.get(k) ?? null; }, async create(k, b) { if (local.has(k)) return "exists"; local.set(k, b); return "created"; } };
  const create = f.deps.store.create;
  f.deps.store.create = async (k, b, type, signal) => { if (k.endsWith("response.json")) { failedPuts++; throw Error("offline"); } return create(k, b, type, signal); };
  expect(await f.module.run(f.input, signal())).toMatchObject({ code: "VISION.HANDOFF_PENDING", candidate });
  expect(await f.module.run(f.input, signal())).toMatchObject({ code: "VISION.HANDOFF_PENDING", replayed: true, candidate });
  expect(f.calls()).toBe(1); expect(failedPuts).toBe(1); expect(local.size).toBe(1);
});
