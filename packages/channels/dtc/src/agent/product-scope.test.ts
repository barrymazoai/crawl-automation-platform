import { expect, it, vi } from "vitest";
import { RetainedPublication, type ObjectStore } from "@crawl-automation/platform";
import {
  DtcProductScope,
  validateProductScope,
  type ProductScopeInput,
  type ProductScopeModel,
} from "./product-scope.js";

const signal = new AbortController().signal;
const fields = {
  title: "Daily Essentials",
  description: "Includes Foundation Multivitamin and a separate Creatine Chews product.",
};
const bundle = {
  kind: "multi_product_bundle",
  reason: "The website sells the two named products together.",
  evidence: [{ field: "description", quote: fields.description }],
  components: [
    {
      name: "Foundation Multivitamin",
      evidence: { field: "description", quote: "Foundation Multivitamin" },
    },
    {
      name: "Creatine Chews",
      evidence: { field: "description", quote: "a separate Creatine Chews product" },
    },
  ],
};
const single = {
  kind: "single_product",
  reason: "One product with selectable servings",
  evidence: [{ field: "title", quote: "Travel Pack" }],
  components: [],
};

function fixture(answer: unknown = bundle) {
  const data = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    read: async (key) => data.get(key) ?? null,
    create: async (key, bytes) => {
      if (data.has(key)) {
        return "exists";
      }
      data.set(key, bytes);
      return "created";
    },
  };
  const model = vi.fn<ProductScopeModel>(async () => JSON.stringify(answer));
  const input: ProductScopeInput = {
    operationId: "scope-test",
    url: "https://example.test/products/daily",
    source: { objectKey: "retained/original.html", sha256: "a".repeat(64), byteSize: 120 },
    fields,
    variants: [],
  };
  return {
    review: new DtcProductScope(new RetainedPublication(store, store), model),
    model,
    data,
    input,
  };
}

it("retains an evidence-backed semantic bundle decision and never repeats the model", async () => {
  const context = fixture();
  const result = await context.review.review(context.input, signal);
  expect(result.decision.kind).toBe("multi_product_bundle");
  expect(await context.review.review(context.input, signal)).toEqual(result);
  expect(context.model).toHaveBeenCalledOnce();
  expect([...context.data.keys()].filter((key) => !key.includes(".publication"))).toEqual(
    expect.arrayContaining([result.evidence.objectKey]),
  );
  expect(context.model.mock.calls[0]?.[0]).toMatchObject({
    prompt: expect.stringContaining("not by URL/title keywords"),
  });
});

it("retains a single-product Travel Pack with two servings options despite its name", async () => {
  const context = fixture(single);
  const result = await context.review.review(
    {
      ...context.input,
      fields: { title: "Travel Pack" },
      variants: [{ title: "7 Day" }, { title: "30 Day" }],
    },
    signal,
  );
  expect(result.decision.kind).toBe("single_product");
});

it("normalizes an original ArtifactRef to its immutable byte reference", async () => {
  const context = fixture();
  const source = {
    ...context.input.source,
    kind: "source-html",
    producer: { module: "dtc.http-original" },
  };
  expect((await context.review.review({ ...context.input, source }, signal)).decision.kind).toBe(
    "multi_product_bundle",
  );
});

it("preserves the answer and blocks a second provider call after invalid citations", async () => {
  const context = fixture({
    ...bundle,
    evidence: [{ field: "description", quote: "invented bundle" }],
  });
  await expect(context.review.review(context.input, signal)).rejects.toThrow("processing scope");
  expect([...context.data.keys()].some((key) => key.endsWith("/answer.json"))).toBe(true);
  await expect(context.review.review(context.input, signal)).rejects.toThrow("processing scope");
  expect(context.model).toHaveBeenCalledOnce();
});

it("does not repeat an uncertain failed model operation", async () => {
  const context = fixture();
  context.model.mockRejectedValue(new Error("provider failed"));
  await expect(context.review.review(context.input, signal)).rejects.toThrow("provider failed");
  await expect(context.review.review(context.input, signal)).rejects.toThrow("processing scope");
  expect(context.model).toHaveBeenCalledOnce();
});

it("keeps insufficient or mixed-option scope unresolved", () => {
  expect(
    validateProductScope(
      {
        kind: "unresolved",
        reason: "Some offers contain multiple products, others one",
        evidence: [],
        components: [],
      },
      fields,
    ).kind,
  ).toBe("unresolved");
});

it("refuses a bundle without two distinct cited components", () => {
  expect(() =>
    validateProductScope({ ...bundle, components: bundle.components.slice(0, 1) }, fields),
  ).toThrow("processing scope");
  expect(() =>
    validateProductScope(
      { ...bundle, components: [bundle.components[0], bundle.components[0]] },
      fields,
    ),
  ).toThrow("processing scope");
});
