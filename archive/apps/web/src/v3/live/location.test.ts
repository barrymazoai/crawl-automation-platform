import { describe, expect, it } from "vitest";
import { brandLocation, selectedBrandId } from "./location";
const id = "e7089c22-835a-4b71-ac60-f61d87498eba";
describe("brand acceptance deep links", () => {
  it("reads only explicit valid brand IDs", () => {
    expect(selectedBrandId(new URL("http://127.0.0.1/v3-live.html"))).toBeNull();
    expect(selectedBrandId(new URL(`http://127.0.0.1/v3-live.html?brand=${id}`))).toBe(id);
  });
  it("refuses malformed or path-like identities", () => {
    expect(() => selectedBrandId(new URL("http://127.0.0.1/?brand=../old"))).toThrow();
  });
  it("preserves the current page and other parameters without navigating to another origin", () => {
    const url = new URL("http://127.0.0.1:4183/v3-live.html?view=test#sources");
    expect(brandLocation(url, id)).toBe(`/v3-live.html?view=test&brand=${id}#sources`);
    expect(url.searchParams.has("brand")).toBe(false);
  });
});
