import { expect, it } from "vitest";
import { nativeAvailability } from "./native-availability.mjs";

const url = "https://shop.example/products/zinc";
const variants = [{ variantId: "42", sku: "Z42" }];
const offer = (id, availability, target = url) => ({ "@type": "Offer", url: `${target}?variant=${id}`, availability: `https://schema.org/${availability}` });
const html = objects => `Sold out <template>Unavailable</template>${objects.map(object => `<script type="application/ld+json">${JSON.stringify(object)}</script>`).join("")}`;
const product = offers => ({ "@type": "Product", url, offers });

it("uses the own offer despite hidden sold-out text and recommendation stock", () => {
  const result = nativeAvailability(html([product([offer("42", "InStock"), offer("other", "OutOfStock", url + "-other")])]), url, variants);
  expect(result.fields.availability).toBe("InStock");
  expect(result.variants).toEqual([{ ...variants[0], availability: "InStock", available: true }]);
});

it.each(["OutOfStock", "PreOrder", "BackOrder"])("retains the real %s offer without treating it as ordinary stock", state => {
  const result = nativeAvailability(html([product(offer("42", state))]), url, variants);
  expect(result.fields.availability).toBe(state);
  expect(result.variants[0].available).toBe(state === "OutOfStock" ? false : undefined);
});

it("preserves different variant states and does not assign one to the base product", () => {
  const source = html([{ "@type": "ProductGroup", url, hasVariant: [
    product(offer("42", "InStock")), product(offer("43", "OutOfStock")),
  ] }]);
  const states = [...variants, { variantId: "43" }];
  expect(nativeAvailability(source, url, states).fields.availability).toBe("");
  const selected = nativeAvailability(source, url + "?variant=43", states);
  expect(selected.fields.availability).toBe("OutOfStock");
  expect(selected.variants.map(v => v.available)).toEqual([true, false]);
});

it.each(["missing", "foreign", "ambiguous", "platform-conflict", "invalid-json"])("does not manufacture stock from %s evidence", reason => {
  const source = reason === "missing" ? "Sold Out Add to cart"
    : reason === "invalid-json" ? '<script type="application/ld+json">bad</script>'
      : html([product(reason === "foreign" ? offer("42", "InStock", "https://other.example/products/zinc")
        : reason === "ambiguous" ? [offer("42", "InStock"), offer("42", "OutOfStock")]
          : offer("42", "InStock"))]);
  const result = nativeAvailability(source, url, reason === "platform-conflict" ? [{ ...variants[0], available: false }] : variants);
  expect(result.fields.availability).toBe("");
  if (["platform-conflict", "ambiguous"].includes(reason)) expect(result.flags).toContain("availability_conflict:42");
});
