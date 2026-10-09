import { expect, it } from "vitest";
import { ProductDeliveryService } from "@crawl-automation/app";
import { deliveryProduct, deliveryRequest, deliverySnapshot } from "./product.fixture.js";
import { DeliveryRpcFake } from "./rpc.fixture.js";
import { SupplySmartObservationWriter } from "./product-observation-writer.js";

function catalogProduct(hostname: string) {
  const source = deliveryProduct();
  if (!source.product || !source.history) {
    throw new Error("fixture");
  }
  const url = `https://${hostname}/products/gummies`;
  source.product.url = url;
  source.product.variants = source.product.variants.map((variant) => ({ ...variant, url }));
  source.history.listing.url = url;
  return source;
}

function setup(hostname: string) {
  const product = catalogProduct(hostname);
  const snapshot = deliverySnapshot([product]);
  snapshot.scans = snapshot.scans.map((scan) => ({ ...scan, siteKey: "sambucolusa.com" }));
  const rpc = new DeliveryRpcFake();
  const service = new ProductDeliveryService({
    reader: { read: async () => snapshot, catalogs: async () => [] },
    writer: new SupplySmartObservationWriter(rpc),
  });
  const request = { ...deliveryRequest, siteKey: "sambucolusa.com" };
  return { product, rpc, run: () => service.deliver(request, new AbortController().signal) };
}

it.each(["sambucolusa.com", "shop.sambucolusa.com"])(
  "delivers %s using the catalog domain for the ingest run, item and label company",
  async (hostname) => {
    const test = setup(hostname);
    expect(await test.run()).toEqual({ captured: 1, review: 0, delivered: 1, refused: [] });
    expect(test.rpc.calls[0]?.input).toMatchObject({
      run: { siteKey: "sambucolusa.com", companyDomain: "sambucolusa.com" },
      items: [{ siteKey: "sambucolusa.com", domain: "sambucolusa.com" }],
    });
    expect(
      test.rpc.calls.find((call) => call.path === "product.ingestLabelObservation")?.input,
    ).toMatchObject({
      company: { domain: "sambucolusa.com", expectedCompanyId: deliveryRequest.companyId },
    });
  },
);

it.each(["sambucol.com", "foreign.test", "evilsambucolusa.com", "sambucolusa.com.foreign.test"])(
  "still refuses the foreign host %s before any RPC",
  async (hostname) => {
    const test = setup(hostname);
    expect(await test.run()).toMatchObject({
      delivered: 0,
      refused: [{ externalId: "variant-1", reason: "PRODUCT_DELIVERY.INTEGRITY" }],
    });
    expect(test.rpc.calls).toEqual([]);
  },
);

it("refuses another group's source even when its product URL uses this group's domain", async () => {
  const test = setup("sambucolusa.com");
  const { product } = test;
  if (!product.collection || !product.history) {
    throw new Error("fixture");
  }
  product.sourceId = "other-source";
  product.collection.observation.sourceId = "other-source";
  product.history.owner.sourceId = "other-source";
  expect(await test.run()).toMatchObject({
    delivered: 0,
    refused: [{ externalId: "variant-1", reason: "PRODUCT_DELIVERY.INTEGRITY" }],
  });
  expect(test.rpc.calls).toEqual([]);
});

it.each(["collection", "history", "product"] as const)(
  "keeps missing %s materials refused independently of the catalog domain",
  async (field) => {
    const test = setup("sambucolusa.com");
    test.product[field] = null;
    expect(await test.run()).toMatchObject({
      delivered: 0,
      refused: [{ externalId: "variant-1", reason: "PRODUCT_DELIVERY.MATERIAL_MISSING" }],
    });
    expect(test.rpc.calls).toEqual([]);
  },
);
