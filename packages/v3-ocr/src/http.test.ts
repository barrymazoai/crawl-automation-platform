import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { MultipartOcr } from "./http.js";
import { png, setup, signal } from "./testing.fixture.js";

let server: Server, origin: string; const requests: string[] = [], bodies: Buffer[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url!); const chunks: Buffer[] = [];
    req.on("data", b => chunks.push(b));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks));
      res.setHeader("Content-Type", "application/json");
      switch (req.url) {
        case "/500": res.writeHead(500); res.end("{}"); break;
        case "/429": res.writeHead(429); res.end("{}"); break;
        case "/redirect": res.writeHead(307, { Location: `${origin}/ok` }); res.end(); break;
        case "/broken": res.end("{broken"); break;
        case "/empty": res.end(JSON.stringify({ text: "  ", lines: [] })); break;
        case "/large": res.end(JSON.stringify({ text: "x".repeat(5000) })); break;
        case "/drop": req.socket.destroy(); break;
        case "/hang": break;
        default: res.end(JSON.stringify({ text: "  unchanged\nraw text  ", lines: [] }));
      }
    });
  });
  await new Promise<void>((r, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", r); });
  const address = server.address(); if (!address || typeof address === "string") throw Error();
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
const provider = (path: string, extra = {}) => new MultipartOcr({ endpoint: origin + path, provider: "test-service/1", allowLoopbackHttp: true, ...extra });
it("sends one real multipart HTTP request with only one image and preserves raw text", async () => {
  const s = await setup(), p = provider("/ok"), before = requests.length;
  expect(await p.recognize(s.input.file, png, signal())).toEqual({ text: "  unchanged\nraw text  ", lines: [] });
  expect(requests.length - before).toBe(1);
  expect(bodies.at(-1)!.toString().match(/name="file"/g)?.length).toBe(1);
  expect(bodies.at(-1)!.includes(png)).toBe(true);
  expect(bodies.at(-1)!.toString()).not.toContain(s.input.file.objectKey);
});
it.each([["/500", "OCR.HTTP_STATUS"], ["/429", "OCR.RATE_LIMIT"], ["/redirect", "OCR.HTTP_STATUS"], ["/broken", "OCR.PROTOCOL"], ["/empty", "OCR.EMPTY"], ["/drop", "OCR.RESPONSE_UNKNOWN"]])("does not retry or follow redirect: %s", async (path, code) => {
  const s = await setup(), before = requests.length;
  await expect(provider(path!).recognize(s.input.file, png, signal())).rejects.toMatchObject({ code });
  expect(requests.length - before).toBe(1);
});
it("bounds actual streamed response", async () => {
  const s = await setup();
  await expect(provider("/large", { maxResponseBytes: 100 }).recognize(s.input.file, png, signal())).rejects.toMatchObject({ code: "OCR.OUTPUT_LIMIT" });
});
it("timeout aborts request without resubmission", async () => {
  const s = await setup(), before = requests.length;
  await expect(provider("/hang", { timeoutMs: 100 }).recognize(s.input.file, png, signal())).rejects.toMatchObject({ code: "OCR.TIMEOUT" });
  expect(requests.length - before).toBe(1);
});
it("honors in-flight external cancellation", async () => {
  const s = await setup(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 100);
  try { await expect(provider("/hang").recognize(s.input.file, png, controller.signal)).rejects.toMatchObject({ code: "OCR.CANCELLED" }); }
  finally { clearTimeout(timer); }
});
it("rejects hash mismatch before any network request", async () => {
  const s = await setup(), before = requests.length;
  await expect(provider("/ok").recognize(s.input.file, Buffer.from("bad"), signal())).rejects.toMatchObject({ code: "OCR.INPUT_INTEGRITY" });
  expect(requests.length).toBe(before);
});
it("rejects insecure/credential-bearing config and closed clients", async () => {
  for (const endpoint of ["http://example.com/ocr", "https://name:password@example.com/ocr", "https://example.com/ocr?key=secret"])
    expect(() => new MultipartOcr({ endpoint, provider: "test/1" })).toThrow();
  const s = await setup(), p = provider("/ok"); await p.close();
  await expect(p.recognize(s.input.file, png, signal())).rejects.toMatchObject({ code: "OCR.CANCELLED" });
});
it("credentials do not enter semantic configuration fingerprint", () => {
  const config = { endpoint: "https://example.com/ocr", provider: "test/1" };
  expect(new MultipartOcr(config, "synthetic-a").supported).toEqual(new MultipartOcr(config, "synthetic-b").supported);
});
it("the fingerprint follows the service semantics, not the address: a LAN box and a loopback box share one queue", () => {
  const mini = new MultipartOcr({ endpoint: "http://192.168.0.6:8081/ocr", trustedHttpOrigin: "http://192.168.0.6:8081", provider: "paddle-ocr/1", minScore: 0.3 });
  const loopback = new MultipartOcr({ endpoint: "http://127.0.0.1:8081/ocr", allowLoopbackHttp: true, provider: "paddle-ocr/1", minScore: 0.3, timeoutMs: 30000 });
  expect(loopback.supported).toEqual(mini.supported);
  expect(new MultipartOcr({ endpoint: "https://example.com/other", provider: "paddle-ocr/1", minScore: 0.3 }).supported.configFingerprint).not.toBe(mini.supported.configFingerprint);
  expect(new MultipartOcr({ endpoint: "http://127.0.0.1:8081/ocr", allowLoopbackHttp: true, provider: "paddle-ocr/2", minScore: 0.3 }).supported.configFingerprint).not.toBe(mini.supported.configFingerprint);
});
it("permits only an explicitly trusted private IPv4 origin, including its port", () => {
  const config = { endpoint: "http://192.168.0.6:8081/ocr", provider: "legacy/1", minScore: 0.3 };
  expect(() => new MultipartOcr(config)).toThrow("OCR.CONFIG");
  const p = new MultipartOcr({ ...config, trustedHttpOrigin: "http://192.168.0.6:8081" });
  expect(p.supported).toMatchObject({ implementationVersion: "multipart-ocr/2", resultSchemaVersion: 2 });
  for (const trustedHttpOrigin of ["http://192.168.0.6", "http://192.168.0.7:8081", "http://192.168.0.6:8081/", "http://192.168.0.6:8081/ocr"])
    expect(() => new MultipartOcr({ ...config, trustedHttpOrigin })).toThrow("OCR.CONFIG");
  for (const host of ["example.com", "8.8.8.8", "169.254.169.254", "0.0.0.0", "172.32.0.1", "127.0.0.1", "[::1]"]) {
    const origin = `http://${host}:8081`;
    expect(() => new MultipartOcr({ ...config, endpoint: `${origin}/ocr`, trustedHttpOrigin: origin })).toThrow("OCR.CONFIG");
  }
  for (const host of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.0.6"]) {
    const origin = `http://${host}:8081`;
    expect(() => new MultipartOcr({ ...config, endpoint: `${origin}/ocr`, trustedHttpOrigin: origin })).not.toThrow();
  }
});
it("sends typed min_score exactly once and fingerprints it without accepting arbitrary queries", async () => {
  const s = await setup(), p = provider("/ocr", { minScore: 0.3 });
  await p.recognize(s.input.file, png, signal());
  expect(requests.at(-1)).toBe("/ocr?min_score=0.3");
  expect(p.supported.configFingerprint).not.toBe(provider("/ocr", { minScore: 0.4 }).supported.configFingerprint);
  expect(p.supported.configFingerprint).not.toBe(provider("/ocr").supported.configFingerprint);
  for (const minScore of [-0.1, 1.1, NaN, Infinity, "0.3"])
    expect(() => provider("/ocr", { minScore })).toThrow();
  expect(() => provider("/ocr?min_score=0.3", { minScore: 0.3 })).toThrow("OCR.CONFIG");
});

it.each(['/empty','/broken'])('attests a fully returned response before validation fails (%s)',async path=>{
 const s=await setup(),returned=vi.fn();
 await expect(provider(path).recognize(s.input.file,png,signal(),returned)).rejects.toThrow();
 expect(returned).toHaveBeenCalledOnce();expect(returned.mock.calls[0]![0]).toBeInstanceOf(Buffer);
});
it.each(['/hang','/drop','/large'])('does not equate a closed client socket with stopped remote OCR (%s)',async path=>{
 const s=await setup(),returned=vi.fn();
 await expect(provider(path,{timeoutMs:100,maxResponseBytes:100}).recognize(s.input.file,png,signal(),returned)).rejects.toThrow();
 expect(returned).not.toHaveBeenCalled();
});
