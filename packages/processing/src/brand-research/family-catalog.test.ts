import { expect, it } from "vitest";
import { checkFamilyAnswer } from "./family-answer.js";
import { archive, family, page, subject } from "./fixtures.test-support.js";

const landedUrl = "https://owner.example/";
const catalogUrl = "https://owner.example/collections/sprout";
const absorbed = {
  ...family,
  landedUrl,
  catalogUrl,
  redirect: { fromDomain: "sprout.example", toDomain: "owner.example", sameBrand: false },
};

it("keeps an absorbed brand's saved collection on the landed domain", () => {
  const saved = archive([page(landedUrl), page(catalogUrl)]);
  const result = checkFamilyAnswer(absorbed, saved, subject);
  expect(result.catalogUrl).toBe(catalogUrl);
  expect(result.archiveKeys).toEqual(saved.archiveKeys);
});

it("also keeps a saved brand catalog on a shared retailer without a redirect", () => {
  const result = checkFamilyAnswer(
    { ...family, catalogUrl: `${subject.brandUrl}brands/sprout` },
    archive([page(subject.brandUrl), page(`${subject.brandUrl}brands/sprout`)]),
  );
  expect(result.catalogUrl).toBe(`${subject.brandUrl}brands/sprout`);
});

it.each([
  [catalogUrl, false],
  ["https://other.example/collections/sprout", true],
  ["https://sprout.example/collections/all", true],
  ["https://owner.example.evil.test/collections/sprout", true],
  ["not a URL", true],
  [null, false],
] as const)("drops unretained, foreign or invalid catalog %s without failing", (url, retained) => {
  const saved = archive([page(landedUrl), ...(url && retained ? [page(url)] : [])]);
  const result = checkFamilyAnswer({ ...absorbed, catalogUrl: url }, saved, subject);
  expect(result.catalogUrl).toBeNull();
  expect(result.redirect?.sameBrand).toBe(false);
  expect(result.clues).toMatchObject([{ signal: "domain_redirect" }]);
});

it("leaves a brand's own site catalog null", () => {
  expect(checkFamilyAnswer(family, archive(), subject).catalogUrl).toBeNull();
});
