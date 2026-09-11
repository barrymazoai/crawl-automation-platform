import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { OcrOutputSchema, OcrResponseSchema, fingerprintOcrInput, type OcrInput } from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/v3-artifacts";
import { fixture } from "../../v3-results/src/testing.fixture.js";
import { MultipartOcr } from "./http.js";
import { OcrFileModule } from "./module.js";
import { png, setup, signal } from "./testing.fixture.js";

// Captured synthetic responses only. This test never contacts the real OCR endpoint.
const evidence = JSON.parse(await readFile(new URL("../../../docs/plane/evidence/CRAWLV3-20/live-results.json", import.meta.url), "utf8")) as {
  details: { label: string; rawResponse: unknown }[];
};
let server: Server, endpoint: string;
const pending = new Map<string, ServerResponse>();
const requests: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const label = Buffer.concat(chunks).toString().match(/SAMPLE:([A-Z]+)/)?.[1];
      if (!label) { res.writeHead(400); res.end(); return; }
      requests.push(label); pending.set(label, res);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw Error();
  endpoint = `http://127.0.0.1:${address.port}/ocr`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
const provider = () => new MultipartOcr({ endpoint, provider: "captured-legacy/1", minScore: 0.3, allowLoopbackHttp: true });
function respond(label: string, body: unknown, status = 200) {
  const res = pending.get(label)!; pending.delete(label);
  res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
}
async function inputFor(s: Awaited<ReturnType<typeof setup>>, p: MultipartOcr, label: string): Promise<OcrInput> {
  const input = fixture().input;
  Object.assign(input, p.supported);
  // PNG transport fixture + marker, not a re-recognition of the original real-service image.
  const bytes = Buffer.concat([png, Buffer.from(`SAMPLE:${label}`)]);
  input.file.sha256 = sha256(bytes); input.file.byteSize = bytes.length;
  input.inputFingerprint = fingerprintOcrInput(input, t => sha256(Buffer.from(t)));
  await s.local.retain(input.file, bytes, signal());
  return input;
}
it("five captured replies run concurrently in one module, finish out of order, and persist exact evidence under the right file", async () => {
  const s = await setup(), p = provider(), module = new OcrFileModule({ ...s.deps, provider: p });
  const inputs = await Promise.all(evidence.details.map(d => inputFor(s, p, d.label)));
  const before = requests.length;
  const jobs = inputs.map(input => module.run(input, signal()));
  // All five HTTP requests must arrive while none has a response: genuine overlap.
  await vi.waitFor(() => expect(requests.length - before).toBe(5));
  for (let n = inputs.length - 1; n >= 0; n--) {
    const item = evidence.details[n]!; respond(item.label, item.rawResponse);
    expect((await jobs[n]!).status).toBe("registered");
  }
  for (let n = 0; n < inputs.length; n++) {
    const input = inputs[n]!, record = (await s.registry.read(input.operationId))!;
    const bytes = s.remote.data.get(record.result.objectKey)!;
    const output = OcrOutputSchema.parse(JSON.parse(Buffer.from(bytes).toString()));
    expect(output.resultSchemaVersion).toBe(2);
    if (output.resultSchemaVersion !== 2) throw Error();
    expect(output.rawResponse).toEqual(evidence.details[n]!.rawResponse);
    expect(record.input.file.artifactId).toBe(input.file.artifactId);
    expect(sha256(bytes)).toBe(record.result.sha256);
    expect(await module.run(input, signal())).toEqual(await jobs[n]);
  }
  expect(requests.length - before).toBe(5); // read-only redelivery, no sixth call
  expect(s.reviews.records.size).toBe(0);
});
it("one cancellation and one HTTP failure do not cancel or corrupt another concurrent file", async () => {
  const s = await setup(), p = provider(), module = new OcrFileModule({ ...s.deps, provider: p });
  const inputs = await Promise.all(["CANCEL", "FAIL", "GOOD"].map(label => inputFor(s, p, label)));
  const controller = new AbortController(), before = requests.length;
  const jobs = inputs.map((input, n) => module.run(input, n === 0 ? controller.signal : signal()));
  await vi.waitFor(() => expect(requests.length - before).toBe(3));
  controller.abort(); respond("FAIL", {}, 500); respond("GOOD", evidence.details[0]!.rawResponse);
  expect(await jobs[0]).toMatchObject({ status: "review", code: "OCR.CANCELLED" });
  expect(await jobs[1]).toMatchObject({ status: "review", code: "OCR.HTTP_STATUS" });
  expect(await jobs[2]).toMatchObject({ status: "registered" });
  for (const input of inputs) await module.run(input, signal());
  expect(requests.length - before).toBe(3);
});
it("complete provider evidence survives failed handoff in Review and later read-only recovery", async () => {
  const s = await setup(), rawResponse = OcrResponseSchema.parse(evidence.details[0]!.rawResponse);
  s.provider.recognize = async () => rawResponse;
  const upload = s.results.uploadMissing.bind(s.results);
  s.results.uploadMissing = async () => { throw Error("synthetic handoff failure"); };
  expect(await s.module.run(s.input, signal())).toMatchObject({ status: "review" });
  const review = [...s.reviews.records.values()][0]!;
  expect(review.candidate).toMatchObject({ schema: "ocr-output/2", value: { rawResponse } });
  await upload(s.input, signal()); await s.results.register(s.input, signal());
  s.provider.recognize = async () => { throw Error("must not re-recognize"); };
  expect(await s.module.run(s.input, signal())).toMatchObject({ status: "registered" });
});
it.each([
  { text: "missing lines" },
  { text: "bad score", lines: [{ text: "line", score: 1.1 }] },
  { text: "bad polygon", lines: [{ text: "line", score: 0.9, polygon: [[0, 0]] }] },
])("malformed provider evidence is rejected by the actual HTTP parser without retry: %j", async body => {
  const s = await setup(), p = provider(), input = await inputFor(s, p, "INVALID"), before = requests.length;
  const module = new OcrFileModule({ ...s.deps, provider: p }), job = module.run(input, signal());
  await vi.waitFor(() => expect(requests.length - before).toBe(1));
  respond("INVALID", body);
  expect(await job).toMatchObject({ status: "review", code: "OCR.PROTOCOL" });
  await module.run(input, signal()); expect(requests.length - before).toBe(1);
});
