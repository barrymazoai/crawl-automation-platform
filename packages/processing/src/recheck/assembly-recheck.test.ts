import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@crawl-automation/platform";
import {
  LabelCollectedProductSchema,
  TextDocumentSchema,
  PreparedPageRecordSchema,
  observationIdentity,
} from "@crawl-automation/v3-contracts";
import { encodeJson } from "../results/result-record.js";
import { recoveredCollection } from "./collection-candidate.js";
import { recheckFixture, signal, productReview } from "./recheck-fixture.js";
import { SavedLabelRecheck } from "./assembly-recheck.js";
import { defined } from "../testing/defined.js";
import { RecheckPreparation } from "./preparation.js";

describe("saved label recovery", () => {
  it("recovers a saved text answer using current checks, with linked receipts and no writes or provider calls", async () => {
    const fixture = await recheckFixture();
    const providers = { model: vi.fn(), ocr: vi.fn(), scraper: vi.fn() };
    const recheck = new SavedLabelRecheck({ ...fixture.deps, ...providers });
    const writes = fixture.remote.writes;
    const label = await recheck.check(fixture.product, signal());
    expect(label.result.status).toBe("ready");
    const proposed = recoveredCollection(label);
    expect(
      LabelCollectedProductSchema.parse(proposed.record).formula.columns[0]?.rows[0]?.name.text,
    ).toBe("Vitamin C");
    expect(proposed.record.operationId).not.toBe(fixture.join.manifest.operationId);
    expect(label.receipts).toMatchObject([
      { kind: "registered-review", receiptId: fixture.sourceReview.reviewId },
    ]);
    expect(fixture.records.get(fixture.product.reviewId)).toEqual(fixture.product);
    expect(fixture.records.get(fixture.sourceReview.reviewId)).toEqual(fixture.sourceReview);
    expect(fixture.remote.writes).toBe(writes);
    Object.values(providers).forEach((port) => expect(port).not.toHaveBeenCalled());
    expect(fixture.deps.verifyOcr).not.toHaveBeenCalled();
  });

  it("refuses original bytes with a mismatched hash", async () => {
    const fixture = await recheckFixture();
    fixture.remote.data.set(fixture.input.page.objectKey, Buffer.from("different html"));
    await expect(fixture.recheck.check(fixture.product, signal())).rejects.toMatchObject({
      code: "ARTIFACT.INTEGRITY",
    });
  });

  it.each(["operationId", "variantId", "listingId"] as const)(
    "refuses a source Review with another %s",
    async (field) => {
      const fixture = await recheckFixture();
      const source = structuredClone(fixture.sourceReview);
      if (field === "operationId") {
        source.failure.operationId = "wrong-operation";
      } else if (source.observation) {
        source.observation[field] = "different";
      }
      fixture.records.set(source.reviewId, source);
      await expect(fixture.recheck.check(fixture.product, signal())).rejects.toMatchObject({
        code: "LABEL_PRODUCT.IDENTITY_CONFLICT",
      });
    },
  );

  it("refuses a receipt marked registered without a ledger registration", async () => {
    const fixture = await recheckFixture();
    fixture.join.states = [{ id: "text", status: "registered" }];
    await expect(
      fixture.recheck.check(productReview(fixture.join), signal()),
    ).rejects.toMatchObject({ code: "RECHECK.RECEIPT_UNVERIFIED" });
  });

  it("keeps an answer that still fails in Review with today's code", async () => {
    const fixture = await recheckFixture();
    const value = defined(fixture.sourceReview.candidate).value as { rawResponse: string };
    const answer = JSON.parse(value.rawResponse);
    answer.formulaComplete = false;
    value.rawResponse = JSON.stringify(answer);
    const output = await fixture.recheck.check(fixture.product, signal());
    expect(output.result.status).toBe("review");
    expect(output.result.codes.length).toBeGreaterThan(0);
    expect(() => recoveredCollection(output)).toThrow();
  });

  it("rejects changed preparation even when its new document hash is internally consistent", async () => {
    const fixture = await recheckFixture();
    if (fixture.task.source.kind !== "prepared") {
      throw new Error("expected prepared fixture");
    }
    const ref = fixture.task.source.document;
    const document = TextDocumentSchema.parse(
      JSON.parse(Buffer.from(defined(fixture.remote.data.get(ref.objectKey))).toString()),
    );
    document.text = document.text.replace("Vitamin C", "Vitamin D");
    const bytes = encodeJson(document);
    fixture.remote.data.set(ref.objectKey, bytes);
    ref.sha256 = sha256(bytes);
    ref.byteSize = bytes.length;
    const key = `v3/pages/${fixture.input.operationId}/completion.json`;
    const completion = PreparedPageRecordSchema.parse(
      JSON.parse(Buffer.from(defined(fixture.remote.data.get(key))).toString()),
    );
    completion.document = ref;
    fixture.remote.data.set(key, encodeJson(completion));
    const prepare = new RecheckPreparation(fixture.deps);
    await expect(
      prepare.document(ref, observationIdentity(fixture.task), signal()),
    ).rejects.toMatchObject({ code: "RECHECK.PREPARATION_CHANGED" });
  });
});
