import { describe, expect, it } from "vitest";
import { acquiredImageId, FILE_CONFIG_FINGERPRINT, PAGE_CONFIG_FINGERPRINT } from "./plan-codec.js";

// Pinned to the values every saved plan and task already uses (computed from the page and file steps on 2026-09-30).
describe("plan fingerprints", () => {
  it("keep the page and file policy fingerprints of saved plans", () => {
    expect(PAGE_CONFIG_FINGERPRINT).toBe(
      "bad56f16adc7b20a21bf881667f0b213d7ee755b9f2d6e71524315efbb80aa92",
    );
    expect(FILE_CONFIG_FINGERPRINT).toBe(
      "352c475dd9c4981e977d6f3aeeffb2d6eaad784a25643c3628f7d71c9c81519c",
    );
  });

  it("keeps the downloaded image ID of a file operation", () => {
    expect(acquiredImageId("op-1")).toBe(
      "file-71a0ef7195df486543f63f0cb1dff83ee245c10fb566219b128a7fa99a8bbbac",
    );
  });
});
