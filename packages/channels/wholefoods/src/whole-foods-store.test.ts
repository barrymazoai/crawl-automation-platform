import { describe, expect, it } from "vitest";
import {
  assertStore,
  shownStore,
  WHOLE_FOODS_STORE,
  wholeFoodsStoreCookie,
} from "./whole-foods-store.js";

// Page data as the 2026-10-01 site sends it: plain JSON, and JSON-escaped inside a Next.js script.
const plain = `{"storePreference":{"buid":"10259","storeAcronym":"ALM","storeName":"The Alameda","locationInfo":{}}}`;
const escaped = String.raw`self.__next_f.push([1,"{\"storePreference\":{\"buid\":\"10145\",\"storeAcronym\":\"LMR\",\"storeName\":\"Lamar\"}}"])`;

describe("Whole Foods store", () => {
  it("writes the store cookie the site reads: base64 JSON with the store ID and delivery ZIP", () => {
    const cookie = wholeFoodsStoreCookie(WHOLE_FOODS_STORE);
    const value = cookie.replace(/^wfm_store_d8=/, "");
    expect(cookie).toMatch(/^wfm_store_d8=[A-Za-z0-9+/=]+$/);
    expect(JSON.parse(atob(value))).toEqual({ id: "10259", deliveryZip: "95126" });
  });

  it.each([
    [plain, { storeId: "10259", name: "The Alameda" }],
    [escaped, { storeId: "10145", name: "Lamar" }],
    ["<header>Pickup at The Alameda</header>", null],
  ])("reads the store from the page data", (html, store) => {
    expect(shownStore(html)).toEqual(store);
  });

  it("accepts only the configured store", () => {
    expect(() => assertStore(plain, WHOLE_FOODS_STORE)).not.toThrow();
    expect(() => assertStore(escaped, WHOLE_FOODS_STORE)).toThrow(
      expect.objectContaining({
        code: "WHOLEFOODS.STORE_MISMATCH",
        details: { shown: "Lamar (10145)", expected: "10259" },
      }),
    );
    expect(() => assertStore("<main></main>", WHOLE_FOODS_STORE)).toThrow(
      expect.objectContaining({ code: "WHOLEFOODS.STORE_UNVERIFIED" }),
    );
  });
});
