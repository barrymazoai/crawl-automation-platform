import { describe, expect, it } from "vitest";
import type { ArtifactRef } from "@crawl-automation/v3-contracts";
import { sha256 as oldSha256, verifyBytes as oldVerifyBytes } from "@crawl-automation/v3-artifacts";
import { AppError } from "../errors/app-error.js";
import { evidenceRef } from "./compatibility-fixture.js";
import { sha256, verifyBytes } from "./integrity.js";

const formats: [ArtifactRef["mediaType"], Buffer][] = [
  ["image/png", Buffer.from("89504e470d0a1a0a0000", "hex")],
  ["image/jpeg", Buffer.from("ffd8ff0001", "hex")],
  ["image/webp", Buffer.from("RIFF0000WEBPVP8 ")],
  ["application/pdf", Buffer.from("%PDF-1.7\r\n")],
  ["text/plain", Buffer.from("中文\r\nretained \ufeff")],
  ["text/html", Buffer.from("<!doctype html>\r\n<p>中文</p>\n")],
  ["application/json", Buffer.from('{ "schemaVersion":1, "value":"中文" }\r\n')],
];

function refFor(bytes: Buffer, mediaType: ArtifactRef["mediaType"]): ArtifactRef {
  return { ...evidenceRef(bytes), mediaType } as ArtifactRef;
}

function outcome(check: () => void): unknown {
  try {
    check();
    return "valid";
  } catch (error) {
    return (error as { code: string }).code;
  }
}

describe("legacy byte and signature compatibility", () => {
  it.each(formats)("keeps %s bytes and SHA-256 unchanged", (mediaType, bytes) => {
    const ref = refFor(bytes, mediaType);
    expect(sha256(bytes)).toBe(oldSha256(bytes));
    expect(verifyBytes(ref, bytes, bytes.length)).toBe(oldVerifyBytes(ref, bytes, bytes.length));
    const padded = Buffer.concat([Buffer.from("prefix"), bytes, Buffer.from("suffix")]);
    expect(sha256(padded.subarray(6, 6 + bytes.length))).toBe(oldSha256(bytes));
  });

  it.each(formats)("keeps %s integrity, size and signature rejection codes", (mediaType, bytes) => {
    const ref = refFor(bytes, mediaType);
    const wrongMedia = refFor(Buffer.from([0, 0xff]), mediaType);
    const cases: [ArtifactRef, Uint8Array, number][] = [
      [ref, bytes, bytes.length - 1],
      [{ ...ref, sha256: "0".repeat(64) }, bytes, 4096],
      [{ ...ref, byteSize: bytes.length + 1 }, bytes, 4096],
      [wrongMedia, Buffer.from([0, 0xff]), 4096],
    ];
    for (const input of cases) {
      expect(outcome(() => verifyBytes(...input))).toBe(outcome(() => oldVerifyBytes(...input)));
    }
  });

  it.each(["{", '"nul\\u0000"', "valid\0invalid", "\ufffd"])(
    "keeps text/JSON parsing decisions for %j",
    (text) => {
      const bytes = Buffer.from(text);
      for (const mediaType of ["text/plain", "text/html", "application/json"] as const) {
        const ref = refFor(bytes, mediaType);
        expect(outcome(() => verifyBytes(ref, bytes, 4096))).toBe(
          outcome(() => oldVerifyBytes(ref, bytes, 4096)),
        );
      }
    },
  );

  it("uses the platform error registry", () => {
    expect(() => verifyBytes(evidenceRef(), Buffer.from("corrupt"), 4096)).toThrow(AppError);
  });

  it("rejects unknown runtime media types just as the old verifier does", () => {
    const bytes = Buffer.from("otherwise valid text");
    // Deliberately bypass the typed media union to exercise the runtime boundary.
    const ref = {
      ...evidenceRef(bytes),
      mediaType: "application/unknown",
    } as unknown as ArtifactRef;
    expect(outcome(() => verifyBytes(ref, bytes, 4096))).toBe(
      outcome(() => oldVerifyBytes(ref, bytes, 4096)),
    );
    expect(outcome(() => verifyBytes(ref, bytes, 4096))).toBe("ARTIFACT.MEDIA_TYPE");
  });
});
