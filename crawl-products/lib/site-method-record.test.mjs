import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { missingSiteMethodFields } from "./site-method-record.mjs";

test("a learned product method needs title, matching URL and usable material", () => {
  const url = "https://example.com/products/a";
  const record = { sourceUrl: url, fields: { title: "A" } };
  deepEqual(missingSiteMethodFields(record, url, ["https://example.com/a.webp"]), []);
  deepEqual(missingSiteMethodFields({ ...record, fields: {} }, url, ["https://example.com/a.webp"]), ["title"]);
  deepEqual(missingSiteMethodFields(record, `${url}-other`, []), ["productUrl", "gallery_or_facts"]);
});
