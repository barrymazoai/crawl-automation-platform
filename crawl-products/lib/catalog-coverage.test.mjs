import { expect, it } from "vitest";
import { dtcCatalogCoverageTarget, verifyDtcCatalogCoverage } from "./catalog-coverage.mjs";

function fixture(collection = "all") {
  const url = `https://shop.example/collections/${collection}`;
  const target = dtcCatalogCoverageTarget(url);
  const entries = [{ url: "https://shop.example/products/zinc" }];
  const proof = { version: target.version, catalogUrl: url, dom: { url, links: entries.map(entry => entry.url) },
    responses: [[{ id: 1, handle: "zinc" }], []].map((products, index) => ({
      url: `${target.endpoint}?limit=100&page=${index + 1}`, status: 200, contentType: "application/json", body: JSON.stringify({ products }),
    })) };
  return { url, entries, proof };
}

it.each(["all", "minerals"])("preserves the old complete set and empty-end proof for %s", collection => {
  const { url, entries, proof } = fixture(collection);
  expect(verifyDtcCatalogCoverage(proof, url, entries)).toBe(true);
});

it.each(["no-end", "api-extra", "api-missing", "duplicates", "wrong-endpoint", "bad-handle", "http-failed", "too-many-pages", "wrong-origin"])("rejects invalid legacy proof: %s", scenario => {
  const { url, entries, proof } = fixture("minerals");
  if (scenario === "no-end") proof.responses.pop();
  if (scenario === "api-extra") proof.responses[0].body = JSON.stringify({ products: [{ id: 1, handle: "zinc" }, { id: 2, handle: "copper" }] });
  if (scenario === "api-missing") proof.responses = [{ ...proof.responses[0], body: '{"products":[]}' }];
  if (scenario === "duplicates") proof.responses[0].body = JSON.stringify({ products: [{ id: 1, handle: "zinc" }, { id: 1, handle: "zinc" }] });
  if (scenario === "wrong-endpoint") proof.responses[0].url = "https://shop.example/products.json?limit=100&page=1";
  if (scenario === "bad-handle") proof.responses[0].body = '{"products":[{"id":1,"handle":"../zinc"}]}';
  if (scenario === "http-failed") proof.responses[0].status = 503;
  if (scenario === "too-many-pages") proof.responses.push(proof.responses[1]);
  if (scenario === "wrong-origin") entries[0].url = "https://foreign.example/products/zinc";
  expect(() => verifyDtcCatalogCoverage(proof, url, entries)).toThrow("DTC.CATALOG_END_UNVERIFIED");
});

it("does not widen the old 100-product proof", () => {
  const { url, entries, proof } = fixture();
  proof.responses[0].body = JSON.stringify({ products: Array.from({length:101}, (_, id) => ({ id:id+1, handle:`item-${id}` })) });
  expect(() => verifyDtcCatalogCoverage(proof, url, entries)).toThrow();
});
