import { describe, expect, it } from "vitest";
import { MemoryStore } from "../testing/memory-store.js";
import { STORAGE_ID, signal, visionSetup } from "../testing/vision-fixture.js";
import type { VisionOutcome } from "./vision-outcome.js";
import { VisionReceipt } from "./vision-receipt.js";
import { VisionRecovery } from "./vision-recovery.js";
import { VisionResults } from "./vision-results.js";

type StoredOutcome = Exclude<VisionOutcome, { status: "review" }>;

/** The Mini side of a cloud run: the shared R2, its own local store, and the ledger. */
function miniSide(cloud: ReturnType<typeof visionSetup>, settleRemote = false) {
  const deps = {
    local: new MemoryStore(),
    remote: cloud.remote,
    registry: cloud.registry,
    evidence: cloud.evidence,
    storageId: STORAGE_ID,
    settleRemote,
  };
  const results = new VisionResults(deps);
  const recovery = new VisionRecovery(results, deps);
  const receipt = new VisionReceipt({
    results: {
      inspect: (task, abort) => results.inspect(task, abort),
      registerFromRemote: (task, abort) => recovery.registerFromRemote(task, abort),
    },
    local: new MemoryStore(),
    reviews: cloud.reviews,
  });
  return { results, recovery, receipt };
}

// Cases carried over from the former vision cloud and handoff tests; the receipt is new with the shared template.
describe("vision in cloud mode", () => {
  it("a worker without a ledger uploads its result and reports it as uploaded", async () => {
    const cloud = visionSetup({ mode: "upload-only" });
    const outcome = await cloud.step.run(cloud.task, signal());
    expect(outcome).toMatchObject({ status: "uploaded", candidateStatus: "candidate" });
    expect(cloud.registry.writes).toBe(0);
    const writes = cloud.remote.writes;
    expect(await cloud.step.run(cloud.task, signal())).toEqual(outcome);
    expect([cloud.model.calls, cloud.remote.writes]).toEqual([1, writes]);
  });

  it("the receipt registers it from R2 once, and repeats harmlessly", async () => {
    const cloud = visionSetup({ mode: "upload-only" });
    const outcome = await cloud.step.run(cloud.task, signal());
    const mini = miniSide(cloud);
    const receipt = await mini.receipt.run({ task: cloud.task, outcome }, signal());
    expect(receipt).toMatchObject({ status: "registered", registration: { status: "candidate" } });
    expect(await mini.receipt.run({ task: cloud.task, outcome }, signal())).toEqual(receipt);
    expect([cloud.registry.writes, cloud.model.calls]).toEqual([1, 1]);
  });

  it("a damaged R2 completion never registers", async () => {
    const cloud = visionSetup({ mode: "upload-only" });
    const outcome = (await cloud.step.run(cloud.task, signal())) as StoredOutcome;
    cloud.remote.data.set(outcome.completion.objectKey, Buffer.from("{}"));
    const receipt = await miniSide(cloud).receipt.run({ task: cloud.task, outcome }, signal());
    expect(receipt).toMatchObject({ status: "review", code: "VISION_RECEIPT.EVIDENCE_UNVERIFIED" });
    expect(cloud.registry.writes).toBe(0);
  });

  it("a label step reads the candidate, registering a cloud result first only when told to", async () => {
    const cloud = visionSetup({ mode: "upload-only" });
    await cloud.step.run(cloud.task, signal());
    await expect(
      miniSide(cloud).recovery.readLabelCandidate(cloud.task, signal()),
    ).rejects.toMatchObject({
      code: "VISION.RESULT_NOT_REGISTERED",
    });
    const read = await miniSide(cloud, true).recovery.readLabelCandidate(cloud.task, signal());
    expect(read.candidate.codec).toBe("label-extraction/1");
    await expect(
      miniSide(cloud).recovery.readCandidate(cloud.task, signal()),
    ).rejects.toMatchObject({
      code: "VISION.LEGACY_PROTOCOL_UNSUPPORTED",
    });
  });
});

describe("vision receipt", () => {
  it("confirms a registered result, and refuses a report whose files differ", async () => {
    const fixture = visionSetup();
    const outcome = (await fixture.step.run(fixture.task, signal())) as StoredOutcome;
    const mini = miniSide(fixture);
    expect(await mini.receipt.run({ task: fixture.task, outcome }, signal())).toMatchObject({
      status: "registered",
    });
    const forged = { ...outcome, result: { ...outcome.result, sha256: "f".repeat(64) } };
    expect(await mini.receipt.run({ task: fixture.task, outcome: forged }, signal())).toMatchObject(
      {
        code: "VISION_RECEIPT.IDENTITY_CONFLICT",
      },
    );
  });

  it("passes the step's own Review on, and refuses an unknown Review ID", async () => {
    const fixture = visionSetup({ answer: "not json" });
    const outcome = await fixture.step.run(fixture.task, signal());
    const mini = miniSide(fixture);
    const passed = await mini.receipt.run({ task: fixture.task, outcome }, signal());
    expect(passed).toMatchObject({
      status: "review",
      code: "VISION.INVALID_OUTPUT",
      imageId: "image-1",
    });
    const missing = { ...outcome, reviewId: "missing-review" };
    expect(
      await mini.receipt.run({ task: fixture.task, outcome: missing }, signal()),
    ).toMatchObject({
      code: "VISION_RECEIPT.REVIEW_UNVERIFIED",
    });
  });

  it("an unconfirmed result stays a Review and never runs the model", async () => {
    const fixture = visionSetup();
    const receipt = await miniSide(fixture).receipt.run(
      { task: fixture.task, outcome: null },
      signal(),
    );
    expect(receipt).toMatchObject({ status: "review", code: "VISION_RECEIPT.RESULT_UNCONFIRMED" });
    expect(fixture.model.calls).toBe(0);
  });
});
