import { expect, it, vi } from "vitest";
import { sha256, type RetainedPublication } from "@crawl-automation/platform";
import { DtcAgentFileTransport } from "./file-transport.js";

function setup() {
  const bytes = Buffer.from("retained bytes");
  const url = "https://shop.example/products/zinc";
  const imageUrl = "https://cdn.example/front.png";
  const objects = new Map([
    [
      "v3/dtc-agent/capture/images.json",
      Buffer.from(
        JSON.stringify({
          version: "dtc-agent-images/1",
          url,
          images: [
            {
              path: "front.png",
              objectKey: "raw-image",
              byteSize: bytes.length,
              sha256: sha256(bytes),
              mediaType: "image/png",
              url: imageUrl,
            },
          ],
        }),
      ),
    ],
    ["raw-image", bytes],
  ]);
  const read = vi.fn(async (key: string) => objects.get(key) ?? null);
  const publication = { remote: { read } } as unknown as RetainedPublication;
  const transport = new DtcAgentFileTransport(publication, {
    operationId: "capture",
    url,
    egressId: "test",
  });
  return { transport, objects, read, imageUrl, bytes };
}

it("supplies the archived original without a browser or HTTP request", async () => {
  const test = setup();
  const response = await test.transport.get(
    new URL(test.imageUrl),
    undefined,
    {},
    new AbortController().signal,
  );
  const chunks = [];
  for await (const chunk of response.body) {
    chunks.push(chunk);
  }
  expect(Buffer.concat(chunks)).toEqual(test.bytes);
  expect(test.read.mock.calls.map(([key]) => key)).toEqual([
    "v3/dtc-agent/capture/images.json",
    "raw-image",
  ]);
});

it.each(["missing", "corrupt", "foreign-url"])("rejects %s retained image", async (kind) => {
  const test = setup();
  if (kind === "missing") {
    test.objects.delete("raw-image");
  }
  if (kind === "corrupt") {
    test.objects.set("raw-image", Buffer.from("wrong original"));
  }
  const url = kind === "foreign-url" ? "https://cdn.example/badge.png" : test.imageUrl;
  await expect(
    test.transport.get(new URL(url), undefined, {}, new AbortController().signal),
  ).rejects.toMatchObject({ code: "DTC.CAPTURE_EVIDENCE" });
});
