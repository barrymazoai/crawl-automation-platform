import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { retainedProjection } from "./retained-projection.js";
import { deliveryProduct } from "./product.fixture.js";

it("reads byte-verified original DTC projections without fetching the site or inferring brand", async () => {
  const product = deliveryProduct().product;
  const bytes = Buffer.from(JSON.stringify({ codec: "dtc-product/2", evidence: product }));
  const read = vi.fn().mockResolvedValue(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  expect(
    await retainedProjection(
      { objects: { read }, references: [{ objectKey: "retained/projection", sha256 }] },
      new AbortController().signal,
    ),
  ).toEqual(product);
  await expect(
    retainedProjection(
      {
        objects: { read },
        references: [{ objectKey: "retained/projection", sha256: "0".repeat(64) }],
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/hash or SKU owner/u);
});
