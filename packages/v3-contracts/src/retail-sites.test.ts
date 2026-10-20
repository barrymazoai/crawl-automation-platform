import { expect, it } from "vitest";
import { retailSiteOf } from "./retail-sites.js";

it("finds the retail site of a URL, bare domain or subdomain", () => {
  expect(retailSiteOf("https://gnc.com/")).toBe("gnc.com");
  expect(retailSiteOf("https://www.gnc.com/vitamins")).toBe("gnc.com");
  expect(retailSiteOf("amazon.com")).toBe("amazon.com");
  expect(retailSiteOf("https://SHOP.Costco.com.")).toBe("costco.com");
});

it("leaves a brand's own site and look-alike domains alone", () => {
  expect(retailSiteOf("https://bloodsugarfriendly.com/")).toBeUndefined();
  expect(retailSiteOf("https://mygnc.com/")).toBeUndefined();
  expect(retailSiteOf("not a url at all")).toBeUndefined();
});
