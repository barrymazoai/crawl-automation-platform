import { expect, it, vi } from "vitest";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { candidate, bytes, selection } from "./testing.fixture.js";
import { VisionModule } from "./module.js";
import { inspectSavedVisionReview } from "./review-recovery.js";
import { visionReviewWriter } from "./review.js";

const signal = () => AbortSignal.timeout(5000);
async function fixture() {
  const local = new MemoryObjects(), remote = new MemoryObjects();
  const task = { input: { operationId: "vision-review-recovery", selection: selection() }, configFingerprint: "a".repeat(64) };
  const output = structuredClone(candidate);
  // Like the real GNC result: a group heading with no printed amount. V1 cannot type it.
  output.formula!.columns[0]!.nutrients[0]!.amount = null;
  const provider = { fingerprint: task.configFingerprint, interpret: vi.fn(async () => JSON.stringify(output)) };
  const verifiedOcrText = vi.fn(async () => "Supplement Facts");
  const original = await new VisionModule({ provider, store: remote, localEvidence: local, verifiedOcrText, resolve: async () => bytes }).run(task.input, signal());
  return { task, local, remote, verifiedOcrText, provider, original };
}
it("rechecks a retained quality failure from an empty cache without model calls or artifact writes", async () => {
  const f = await fixture(), writes = f.remote.writes;
  expect(f.original.code).toBe("VISION.CORE_MISSING");
  const outcome = await inspectSavedVisionReview(f.task, { ...f, local: new MemoryObjects() }, signal());
  expect(outcome).toEqual({ ...f.original, replayed: true });
  const append = vi.fn(async record => ({ reviewId: record.reviewId }));
  await visionReviewWriter(f.local, { append })(f.task, outcome, signal());
  expect(append).toHaveBeenCalledOnce();
  expect(append.mock.calls[0]![0]).toMatchObject({ failure: { code: "VISION.CORE_MISSING", executionFact: "executed", automaticRetry: false } });
  expect(f.provider.interpret).toHaveBeenCalledOnce();
  expect(f.remote.writes).toBe(writes);
});
it("cannot execute when no prior intent exists", async () => {
  const f = await fixture(); f.remote.data.clear(); const writes = f.remote.writes;
  await expect(inspectSavedVisionReview(f.task, f, signal())).rejects.toThrow("VISION.RECOVERY_EXECUTION_DENIED");
  expect(f.remote.writes).toBe(writes); expect(f.provider.interpret).toHaveBeenCalledOnce();
});
it.each(["absent", "corrupt", "wrong-config", "unverified-ocr"])("does not recover %s evidence as a quality Review", async kind => {
  const f = await fixture(), key = f.original.evidenceKey, writes = f.remote.writes;
  if (kind === "absent") f.remote.data.delete(key);
  if (kind === "corrupt") f.remote.data.set(key, Buffer.from("corrupt"));
  if (kind === "wrong-config") f.task.configFingerprint = "b".repeat(64);
  if (kind === "unverified-ocr") f.verifiedOcrText.mockRejectedValueOnce(Error("OCR_UNVERIFIED"));
  await expect(inspectSavedVisionReview(f.task, f, signal())).rejects.toThrow();
  expect(f.remote.writes).toBe(writes); expect(f.provider.interpret).toHaveBeenCalledOnce();
});
