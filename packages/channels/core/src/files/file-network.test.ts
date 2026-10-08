import { describe, expect, it } from "vitest";
import { ANY_HTTPS_ORIGIN, permittedUrl } from "./file-network.js";

describe("permittedUrl", () => {
  it("keeps a plain allowlist strict", () => {
    expect(permittedUrl("https://shop.test/a.png", ["https://shop.test"]).href).toBe(
      "https://shop.test/a.png",
    );
    expect(() => permittedUrl("https://cdn.other.test/a.png", ["https://shop.test"])).toThrow(
      expect.objectContaining({ code: "SOURCE.ORIGIN_BLOCKED" }),
    );
  });

  it("admits any public HTTPS host with the wildcard entry, and nothing unsafe (owner 2026-10-08)", () => {
    const any = [ANY_HTTPS_ORIGIN];
    expect(permittedUrl("https://cdn.awccloud.com/images/a.webp", any).hostname).toBe(
      "cdn.awccloud.com",
    );
    for (const unsafe of [
      "http://cdn.awccloud.com/a.webp",
      "https://user:pw@cdn.awccloud.com/a.webp",
      "https://cdn.awccloud.com:8443/a.webp",
      "https://10.0.0.1/a.webp",
    ]) {
      expect(() => permittedUrl(unsafe, any)).toThrow(
        expect.objectContaining({ code: "SOURCE.ORIGIN_BLOCKED" }),
      );
    }
  });
});
