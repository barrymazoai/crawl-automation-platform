import { afterEach, beforeEach, expect, it } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { variantCaptureFixture } from "./variant-capture-fixture.js";
import { verifyDetailReview } from "./detail-review.js";
import { capturedProductProjection } from "./product-projection.js";

let sample: Awaited<ReturnType<typeof variantCaptureFixture>>;
beforeEach(async () => {
  sample = await variantCaptureFixture();
});
afterEach(async () => {
  await rm(sample.root, { recursive: true, force: true });
});

it("requires a detail proof for new captures but keeps historical originals readable", async () => {
  await expect(verifyDetailReview(sample.input)).resolves.toBeUndefined();
  await expect(verifyDetailReview({ ...sample.input, required: true })).rejects.toMatchObject({
    code: "DTC.CAPTURE_EVIDENCE",
    details: { reason: "detail_coverage_unverified" },
  });
});

it("verifies archived proof and rejects an evidence file absent from the archive", async () => {
  const common = { reason: "Inspected retained source", evidence: ["product.json"], imageUrls: [] };
  const proof = {
    version: "observed-details/1",
    checkScope: "website-text",
    reachedEnd: true,
    pageEvidence: ["variant-1.html"],
    sections: [
      {
        ...common,
        name: "Description",
        status: "captured",
        field: "description",
        location: { source: 0, pointer: "/product/body_html" },
      },
    ],
    checks: ["description", "ingredients", "directions", "warnings", "facts"].map((kind) => ({
      ...common,
      kind,
      status: kind === "description" ? "captured" : "not-present",
      fields: kind === "description" ? ["description"] : [],
    })),
  };
  await sample.save("detail-proof.json", JSON.stringify(proof));
  sample.input.review.detailCoveragePath = "detail-proof.json";
  await expect(verifyDetailReview({ ...sample.input, required: true })).resolves.toBeUndefined();
  await expect(
    verifyDetailReview({
      ...sample.input,
      files: sample.input.files.filter((file) => file.path !== "variant-1.html"),
    }),
  ).rejects.toMatchObject({ code: "DTC.CAPTURE_EVIDENCE" });
  await writeFile(
    join(sample.root, "detail-proof.json"),
    JSON.stringify({ ...proof, reachedEnd: false }),
  );
  await expect(verifyDetailReview(sample.input)).rejects.toMatchObject({
    code: "DTC.CAPTURE_EVIDENCE",
    details: { reason: "detail_coverage_unverified" },
  });
});

it("does not substitute base-product detail proof for each variant's own missing handoff", async () => {
  sample.input.review.detailCoveragePath = "base-details.json";
  const variants = await sample.publish();
  expect(variants.map((member) => member.status)).toEqual(["review", "review"]);
  expect(sample.input.record.variants).toHaveLength(2);
});

it("continues the variant with its own verified details while isolating a sibling missing proof", async () => {
  const context = sample.contexts[0];
  if (!context) {
    throw new Error("fixture context missing");
  }
  const method = JSON.parse(
    Buffer.from(sample.data.get("original/method-1.json") ?? []).toString(),
  );
  const common = {
    reason: "Own observed variant details",
    evidence: ["variant-1.html"],
    imageUrls: [],
  };
  const proof = {
    version: "observed-details/1",
    checkScope: "website-text",
    reachedEnd: true,
    pageEvidence: ["variant-1.html"],
    sections: ["description", "ingredients"].map((field) => ({
      ...common,
      name: field,
      status: "captured",
      field,
      location: method.fields[field],
    })),
    checks: ["description", "ingredients", "directions", "warnings", "facts"].map((kind) => ({
      ...common,
      kind,
      status: ["description", "ingredients"].includes(kind) ? "captured" : "not-present",
      fields: ["description", "ingredients"].includes(kind) ? [kind] : [],
    })),
  };
  await sample.save("variant-1-details.json", JSON.stringify(proof));
  context.detailCoveragePath = "variant-1-details.json";
  sample.input.review.detailCoveragePath = "base-details.json";
  await sample.preflight();
  const members = await sample.publish();
  expect(members.map((member) => [member.variant.variantId, member.status])).toEqual([
    ["1", "ready"],
    ["2", "review"],
  ]);
});

it("keeps explicitly selected HTML structure in downstream details without treating ordinary text as HTML", () => {
  const record = sample.input.record;
  record.fields.description = "<table><tr><th>Size</th><td>30</td></tr></table>";
  record.fields.warning = "Use < 1 tablet";
  record.fieldEvidence = { fields: { description: { format: "html" } } };
  const projection = capturedProductProjection({ ...sample.input, url: sample.input.request.url });
  expect(projection.evidence.detailsHtml).toContain(
    "<table><tr><th>Size</th><td>30</td></tr></table>",
  );
  expect(projection.evidence.detailsHtml).toContain("Use &lt; 1 tablet");
});
