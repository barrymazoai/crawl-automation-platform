import { expect, it, vi } from "vitest";
import { allowedHop, redirectFacts } from "./scraperapi-redirects.js";
import * as settings from "./scraperapi-settings.js";

it("treats SOURCE.ORIGIN_BLOCKED as a refused hop and never exposes provider keys", () => {
  const target = new URL("https://example.com/product");
  expect(allowedHop("/next", target, [target.origin])?.href).toBe("https://example.com/next");
  expect(allowedHop("https://other.test", target, [target.origin])).toBeNull();
  expect(allowedHop("https://[invalid", target, [target.origin])).toBeNull();
  expect(
    redirectFacts({
      status: 302,
      target: target.href,
      location: "https://api.scraperapi.com?api_key=private",
    }),
  ).not.toHaveProperty("location");
});

it("does not swallow an unexpected target-validation failure", () => {
  const failure = new Error("unexpected validator failure");
  const validator = vi.spyOn(settings, "allowedTarget").mockImplementation(() => {
    throw failure;
  });
  expect(() =>
    allowedHop("/next", new URL("https://example.com"), ["https://example.com"]),
  ).toThrow(failure);
  validator.mockRestore();
});
