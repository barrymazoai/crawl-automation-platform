import { describe, expect, it } from "vitest";
import addresses from "./fixtures/ocr-api-addresses.json" with { type: "json" };
import recorded from "./fixtures/ocr-api-answer.json" with { type: "json" };
import { PNG, ocrTask, signal } from "../testing/ocr-fixture.js";
import { OcrApi } from "./ocr-api.js";
import { OcrApiSettingsSchema, ocrCompatibility } from "./ocr-api-settings.js";

const BASE_URL = "https://ocr.example.test";

/** Stands in for the OCR API: records each request and answers with the given response. */
function fakeService(answer: (request: Request) => Promise<Response>) {
  const requests: Request[] = [];
  const fetch = async (request: Request) => {
    requests.push(request.clone());
    return answer(request);
  };
  return { requests, fetch };
}

const json =
  (status: number, value: unknown, type = "application/json") =>
  async () =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": type } });

function api(service: ReturnType<typeof fakeService>, settings: object = {}) {
  const parsed = OcrApiSettingsSchema.parse({
    baseUrl: BASE_URL,
    provider: "rapidocr/1",
    ...settings,
  });
  return new OcrApi(parsed, { fetch: service.fetch });
}

const recognize = (client: OcrApi, bytes: Uint8Array = PNG) =>
  client.recognize(ocrTask().file, bytes, signal());

describe("OCR API client", () => {
  it("sends the image as one multipart file and keeps the recorded answer whole", async () => {
    const service = fakeService(json(200, recorded));
    expect(await recognize(api(service, { minScore: 0.3 }))).toEqual(recorded);
    const [request] = service.requests;
    expect(request?.url).toBe(`${BASE_URL}/ocr?min_score=0.3`);
    const file = (await request?.formData())?.get("file") as File;
    expect(file.name).toBe("image.png");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
  });

  it.each([
    [429, "OCR.RATE_LIMIT"],
    [500, "OCR.HTTP_STATUS"],
    [415, "OCR.HTTP_STATUS"],
  ])("an answer with status %i is %s", async (status, code) => {
    const service = fakeService(json(status, { error: "refused" }));
    await expect(recognize(api(service))).rejects.toMatchObject({ code });
  });

  it("a non-JSON or unreadable answer is a protocol failure", async () => {
    const html = fakeService(json(200, recorded, "text/html"));
    const broken = fakeService(
      async () => new Response("{broken", { headers: { "content-type": "application/json" } }),
    );
    await expect(recognize(api(html))).rejects.toMatchObject({ code: "OCR.PROTOCOL" });
    await expect(recognize(api(broken))).rejects.toMatchObject({ code: "OCR.PROTOCOL" });
  });

  it.each(["", "  \n\t"])("keeps a successful no-text response %j unchanged", async (text) => {
    const answer = { text, lines: [], detector: "test" };
    const service = fakeService(json(200, answer));
    await expect(recognize(api(service))).resolves.toEqual(answer);
    expect(service.requests).toHaveLength(1);
  });

  it("missing text is still a protocol failure, not a no-text result", async () => {
    const service = fakeService(json(200, { lines: [] }));
    await expect(recognize(api(service))).rejects.toMatchObject({ code: "OCR.PROTOCOL" });
  });

  it("bytes that are not the referenced image are never sent", async () => {
    const service = fakeService(json(200, recorded));
    await expect(
      recognize(api(service), Buffer.concat([PNG, Buffer.from("x")])),
    ).rejects.toMatchObject({
      code: "OCR.INPUT_INTEGRITY",
      details: { executionFact: "not_executed" },
    });
    expect(service.requests).toHaveLength(0);
  });

  it("an answer slower than the timeout is a timeout, with the call's outcome unknown", async () => {
    const never = fakeService(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
        }),
    );
    await expect(recognize(api(never, { timeoutMs: 100 }))).rejects.toMatchObject({
      code: "OCR.TIMEOUT",
      details: { executionFact: "unknown" },
    });
  });
});

describe("OCR API settings", () => {
  const valid = (baseUrl: string) =>
    OcrApiSettingsSchema.safeParse({ baseUrl, provider: "x/1" }).success;

  it.each(addresses.allowed)("allow %s", (address) => expect(valid(address)).toBe(true));
  it.each(addresses.refused)("refuse %s", (address) => expect(valid(address)).toBe(false));

  it.each([
    [10, 0, 0, 1],
    [172, 16, 0, 1],
    [192, 168, 0, 1],
  ])("allows HTTP to an RFC 1918 address %j", (...octets) => {
    expect(valid(`http://${octets.join(".")}:8081`)).toBe(true);
  });

  it("name the same OCR setup as the previous client, so existing tasks and results stay valid", () => {
    const settings = (raw: object) =>
      OcrApiSettingsSchema.parse({ baseUrl: BASE_URL, provider: "rapidocr-ppocrv5/1", ...raw });
    // Fingerprints the previous client (v3-ocr MultipartOcr) computed for the same settings.
    expect(ocrCompatibility(settings({ minScore: 0.3 })).configFingerprint).toBe(
      "c1388e001dd6ce4c9554205ef7c5b4ab5c311b46d2ca8f9b720d1ed3e77694d0",
    );
    expect(ocrCompatibility(settings({})).configFingerprint).toBe(
      "8cb57e3eeb9aa86deea1ccf84872d338041d06ecaa343a199d78f27c57ff3ac9",
    );
  });
});
