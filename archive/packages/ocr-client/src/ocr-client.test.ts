import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OcrClient } from "./index";

describe("OcrClient", () => {
  it("retries one transient failure and validates the response", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-client-"));
    const image = path.join(directory, "label.png"); await fs.writeFile(image, "fake-image");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("error", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ text: "Vitamin C", lines: [{ text: "Vitamin C", score: 0.99, polygon: [] }] }));
    const client = new OcrClient({ endpoint: "http://ocr.local/ocr", retries: 1, timeoutMs: 1000, fetchImpl });
    expect(await client.recognize(image)).toMatchObject({ text: "Vitamin C" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await fs.rm(directory, { recursive: true, force: true });
  });
});

