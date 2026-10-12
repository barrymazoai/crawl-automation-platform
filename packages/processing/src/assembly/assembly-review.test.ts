import { expect, it } from "vitest";
import { assemblySetup } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import { recordAssemblyReview } from "./assembly-review.js";

it.each([false, true])(
  "preserves the immutable first Review and identity (existing cause=%s)",
  async (hasCause) => {
    const setup = assemblySetup();
    setup.join.manifest.evidencePolicy = "label-image-first/4";
    const cause = { code: null, name: "Error", message: "First cause" };
    const review = {
      input: setup.join,
      codes: ["LABEL_PRODUCT.EVIDENCE_UNRESOLVED"],
      key: "test/assembly.json",
      stage: "collect" as const,
      candidate: null,
      ...(hasCause ? { cause } : {}),
    };
    const first = await recordAssemblyReview(setup.deps, review);
    const record = defined([...setup.records.values()][0]);
    const original = JSON.stringify(record);
    expect(
      await recordAssemblyReview(setup.deps, {
        ...review,
        cause: { ...cause, message: "Later diagnosis" },
      }),
    ).toEqual(first);
    expect(JSON.stringify([...setup.records.values()][0])).toBe(original);
    expect(setup.records.size).toBe(1);
  },
);

it("still rejects a changed stored Review outside the additive cause fields", async () => {
  const setup = assemblySetup();
  setup.join.manifest.evidencePolicy = "label-image-first/4";
  const review = {
    input: setup.join,
    codes: ["LABEL_PRODUCT.EVIDENCE_UNRESOLVED"],
    key: "test/assembly.json",
    stage: "collect" as const,
    candidate: null,
  };
  await recordAssemblyReview(setup.deps, review);
  const [key, bytes] = defined(
    [...setup.remote.data.entries()].find(([key]) => key.includes("/reviews/")),
  );
  const record = JSON.parse(new TextDecoder().decode(bytes));
  record.failure.operationId = "foreign";
  setup.remote.data.set(key, new TextEncoder().encode(JSON.stringify(record)));
  await expect(recordAssemblyReview(setup.deps, review)).rejects.toMatchObject({
    code: "LABEL_PRODUCT.REVIEW_UNVERIFIED",
  });
});
