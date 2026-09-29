import { describe, expect, it } from "vitest";
import { MemoryStore } from "../testing/memory-store.js";
import { signal, textFixture } from "../testing/text-fixture.js";
import { TextReceipt } from "./text-receipt.js";

function receiptFor(given: ReturnType<typeof textFixture>) {
  return new TextReceipt({
    results: given.results,
    local: new MemoryStore(),
    reviews: given.reviews,
  });
}

describe("TextReceipt", () => {
  it("confirms a registered result exactly as the text step reported it", async () => {
    const given = textFixture();
    const outcome = await given.step.run(given.input, signal());

    const receipt = await receiptFor(given).run({ input: given.input, outcome }, signal());

    expect(receipt.status).toBe("registered");
  });

  it("a reported result that differs from the ledger is an identity conflict, recorded as a Review", async () => {
    const given = textFixture();
    const outcome = await given.step.run(given.input, signal());
    if (outcome.status !== "registered") {
      throw new Error("fixture must register");
    }
    const forged = { ...outcome, result: { ...outcome.result, sha256: "b".repeat(64) } };

    const receipt = await receiptFor(given).run({ input: given.input, outcome: forged }, signal());

    expect(receipt).toMatchObject({ status: "review", code: "TEXT_RECEIPT.IDENTITY_CONFLICT" });
  });

  it("confirms the text step's own Review and never turns it into a success", async () => {
    const given = textFixture();
    given.model.interpret = async () => "not json";
    const outcome = await given.step.run(given.input, signal());

    const receipt = await receiptFor(given).run({ input: given.input, outcome }, signal());

    expect(receipt).toMatchObject({ status: "review", code: "TEXT.MODEL_SCHEMA" });
  });

  it("a result that is not registered is unconfirmed", async () => {
    const given = textFixture();

    const receipt = await receiptFor(given).run({ input: given.input, outcome: null }, signal());

    expect(receipt).toMatchObject({ status: "review", code: "TEXT_RECEIPT.TEXT_UNCONFIRMED" });
  });

  it("when its own Review cannot be written, the failure is reported, never success", async () => {
    const given = textFixture();
    given.reviews.failAppends = true;

    await expect(
      receiptFor(given).run({ input: given.input, outcome: null }, signal()),
    ).rejects.toMatchObject({
      code: "TEXT_RECEIPT.REVIEW_UNVERIFIED",
    });
  });
});
