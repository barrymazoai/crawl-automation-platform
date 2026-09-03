import { describe, expect, it } from "vitest";
import { OcrClient, OcrRejectedError } from "./index.js";

const file = new URL(import.meta.url).pathname;

function stubFetch(status: number, counter: { n: number }) {
  return (async () => {
    counter.n += 1;
    if (status === 200) return new Response(JSON.stringify({ text: "ok", lines: [] }), { status, headers: { "content-type": "application/json" } });
    return new Response("", { status });
  }) as unknown as typeof fetch;
}

describe("OCR 客户端的重试边界", () => {
  it("415 这类 4xx 立刻放弃，不重试", async () => {
    const counter = { n: 0 };
    const client = new OcrClient({ endpoint: "http://ocr.invalid/ocr", retries: 3, fetchImpl: stubFetch(415, counter) });
    await expect(client.recognize(file)).rejects.toBeInstanceOf(OcrRejectedError);
    expect(counter.n).toBe(1);
  });

  it("5xx 仍然按 retries 重试", async () => {
    const counter = { n: 0 };
    const client = new OcrClient({ endpoint: "http://ocr.invalid/ocr", retries: 2, fetchImpl: stubFetch(503, counter) });
    await expect(client.recognize(file)).rejects.toThrow("OCR HTTP 503");
    expect(counter.n).toBe(3);
  });

  it("正常返回照旧", async () => {
    const counter = { n: 0 };
    const client = new OcrClient({ endpoint: "http://ocr.invalid/ocr", fetchImpl: stubFetch(200, counter) });
    expect((await client.recognize(file)).text).toBe("ok");
  });
});
