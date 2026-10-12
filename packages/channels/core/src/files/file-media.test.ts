import { describe, expect, it } from "vitest";
import { inspectMedia } from "./file-media.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);

describe("media failure diagnostics", () => {
  it.each([
    ["GIF", Buffer.from("GIF89a"), "image/gif"],
    [
      "AVIF major brand",
      Buffer.from("000000186674797061766966000000006d6966316d696166", "hex"),
      "image/avif",
    ],
    [
      "AVIF compatible brand",
      Buffer.from("00000018667479706d69663100000000617669666d696166", "hex"),
      "image/avif",
    ],
    ["HTML", Buffer.from("\uFEFF \n<!doctype html><html>error</html>"), "text/html"],
    ["unknown", Buffer.from([0, 1, 2, 3]), null],
    ["supported type with wrong header", png, "image/png"],
  ])("reports %s without accepting new formats", (_name, bytes, sniffedMediaType) => {
    expect(() => inspectMedia(bytes as Buffer, "image/jpeg", 40000000)).toThrow(
      expect.objectContaining({
        code: "ARTIFACT.MEDIA_TYPE",
        details: {
          contentType: "image/jpeg",
          sniffedMediaType,
          byteSize: (bytes as Buffer).length,
        },
      }),
    );
  });

  it("still accepts a matching PNG and the existing octet-stream fallback", () => {
    for (const contentType of ["image/png", "application/octet-stream", undefined]) {
      expect(inspectMedia(png, contentType, 40000000)).toEqual({
        mediaType: "image/png",
        dimensions: { width: 1, height: 1 },
      });
    }
  });

  it("keeps legacy PDF container screening unchanged", () => {
    expect(inspectMedia(Buffer.from("%PDF-1.4\n%%EOF\n"), "application/pdf", 40000000)).toEqual({
      mediaType: "application/pdf",
      dimensions: null,
    });
  });
});
