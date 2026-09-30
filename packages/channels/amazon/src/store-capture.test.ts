import { describe, expect, it } from "vitest";
import { amazonAdapter } from "./adapter.js";
import { storeHome } from "./testing/store-fakes.js";

describe("Amazon brand-source capture", () => {
  it.each([storeHome, storeHome.replace("/page/", "/HerbPharm/page/") + "?ref_=test"])(
    "selects the browser for Store source %s",
    (url) => expect(amazonAdapter.scanCapture?.(url)).toBe("browser"),
  );

  it.each([
    "https://www.amazon.com/s?rh=p_89%3AHerb+Pharm",
    "https://www.amazon.com/s?srs=123456&rh=p_89%3AHerb+Pharm",
    "https://www.amazon.com/s?rh=p_89%3AHerb+Pharm&ref_=/stores/page/ignored",
  ])("keeps search and brand-page source %s on HTTP", (url) => {
    expect(amazonAdapter.scanCapture?.(url)).toBe("http");
  });

  it("keeps product capture on HTTP", () => {
    expect(amazonAdapter.captureModes).toEqual(["http"]);
  });
});
