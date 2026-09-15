import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { VersionTagSchema, OcrResponseSchema, type OcrResponse, type ProcessingCompatibility, type OcrInput } from "@crawl-automation/v3-contracts";
import { sha256, verifyBytes } from "@crawl-automation/v3-artifacts";
import { OcrError, type OcrProvider } from "./ports.js";

export const MultipartOcrConfigSchema = z.strictObject({ endpoint: z.url(), provider: VersionTagSchema,
  timeoutMs: z.number().int().min(100).max(60000).default(45000),
  maxInputBytes: z.number().int().min(1).max(16777216).default(16777216),
  maxResponseBytes: z.number().int().min(1).max(8388608).default(8388608),
  allowLoopbackHttp: z.boolean().default(false),
  // One explicit RFC1918 IPv4 origin, including port. No DNS names, CIDRs or global bypass.
  trustedHttpOrigin: z.string().optional(),
  minScore: z.number().min(0).max(1).optional() });
export type MultipartOcrConfig = z.input<typeof MultipartOcrConfigSchema>;
function isPrivateIpv4(host: string): boolean {
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split(".").map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}

/** Existing custom service protocol: multipart field `file` -> {text,lines,...evidence}. */
export class MultipartOcr implements OcrProvider {
  readonly provider: string;
  readonly supported: ProcessingCompatibility;
  private readonly config: z.output<typeof MultipartOcrConfigSchema>;
  private readonly endpoint: URL;
  private closed = false;
  constructor(raw: MultipartOcrConfig, private readonly bearerToken?: string) {
    this.config = MultipartOcrConfigSchema.parse(raw);
    this.endpoint = new URL(this.config.endpoint);
    const trusted = this.config.trustedHttpOrigin;
    if (trusted !== undefined) {
      let origin: URL;
      try { origin = new URL(trusted); } catch { throw new OcrError("OCR.CONFIG", "not_executed"); }
      if (origin.protocol !== "http:" || trusted !== origin.origin || !isPrivateIpv4(origin.hostname) ||
          origin.origin !== this.endpoint.origin) throw new OcrError("OCR.CONFIG", "not_executed");
    }
    if (this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash ||
        (this.endpoint.protocol !== "https:" && !(this.endpoint.protocol === "http:" &&
          (trusted === this.endpoint.origin || (this.config.allowLoopbackHttp && ["127.0.0.1", "[::1]"].includes(this.endpoint.hostname))))) ||
        (bearerToken !== undefined && (!bearerToken || /[\r\n]/.test(bearerToken)))) throw new OcrError("OCR.CONFIG", "not_executed");
    if (this.config.minScore !== undefined) this.endpoint.searchParams.set("min_score", String(this.config.minScore));
    this.provider = this.config.provider;
    this.supported = { module: "ocr.file", schemaVersion: 1, implementationVersion: "multipart-ocr/2", policyVersion: "single-call/1",
      resultSchemaVersion: 2,
      // Semantic configuration only: which service protocol and which thresholds/limits shape the output. The network
      // address (endpoint, trusted origin, loopback allowance, timeout) is where a worker reaches its own OCR box and
      // must not split one generic OCR queue by machine.
      configFingerprint: sha256(Buffer.from(JSON.stringify({ provider: this.config.provider, path: this.endpoint.pathname, minScore: this.config.minScore ?? null,
        maxInputBytes: this.config.maxInputBytes, maxResponseBytes: this.config.maxResponseBytes }))) };
  }
  async close(): Promise<void> { this.closed = true; }
  async recognize(file: OcrInput["file"], source: Uint8Array, signal: AbortSignal, onReturned?: (response: Uint8Array) => void): Promise<OcrResponse> {
    if (this.closed || signal.aborted) throw new OcrError("OCR.CANCELLED", "not_executed");
    if (!["source-image", "pdf-page"].includes(file.kind)) throw new OcrError("OCR.INVALID_INPUT", "not_executed");
    if (source.byteLength > this.config.maxInputBytes) throw new OcrError("OCR.INPUT_LIMIT", "not_executed");
    const bytes = Buffer.from(source);
    try { verifyBytes(file, bytes, this.config.maxInputBytes); } catch { throw new OcrError("OCR.INPUT_INTEGRITY", "not_executed"); }
    const boundary = `v3-${randomUUID()}`;
    const extension = file.mediaType === "image/png" ? "png" : file.mediaType === "image/jpeg" ? "jpg" : "webp";
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.${extension}"\r\nContent-Type: ${file.mediaType}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const response = await new Promise<Buffer>((resolve, reject) => {
      let failure: OcrError | undefined, complete: Buffer | undefined;
      const req = (this.endpoint.protocol === "https:" ? httpsRequest : httpRequest)(this.endpoint, {
        method: "POST", agent: false, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length,
          "Accept": "application/json", ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}) },
      });
      const stop = (error: OcrError) => { failure ??= error; req.destroy(); };
      const abort = () => stop(new OcrError("OCR.CANCELLED"));
      const timer = setTimeout(() => stop(new OcrError("OCR.TIMEOUT")), this.config.timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      req.on("response", res => {
        if (res.statusCode !== 200) { stop(new OcrError(res.statusCode === 429 ? "OCR.RATE_LIMIT" : "OCR.HTTP_STATUS")); res.destroy(); return; }
        if (!/^application\/json(?:\s*;|$)/i.test(String(res.headers["content-type"] ?? "")) ||
            (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")) {
          stop(new OcrError("OCR.PROTOCOL")); res.destroy(); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > this.config.maxResponseBytes) { stop(new OcrError("OCR.OUTPUT_LIMIT")); res.destroy(); }
          else chunks.push(chunk);
        });
        res.on("end", () => { if (res.complete) complete = Buffer.concat(chunks, size); });
        res.on("error", () => stop(new OcrError("OCR.RESPONSE_UNKNOWN")));
      });
      req.on("error", () => { failure ??= new OcrError("OCR.RESPONSE_UNKNOWN"); });
      req.on("close", () => {
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        if (failure || !complete) reject(failure ?? new OcrError("OCR.RESPONSE_UNKNOWN")); else resolve(complete);
      });
      req.end(body);
    });
    // A complete synchronous response AND request close precede parsing. Empty or
    // malformed output does not mean the provider is still using the OCR slot.
    // Destroying a timed-out socket above deliberately does not call this hook.
    onReturned?.(response);
    try {
      const parsed = OcrResponseSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response)));
      if (!parsed.text.trim()) throw new OcrError("OCR.EMPTY", "executed");
      return parsed; // Preserve provider JSON values; no Codex/Formula inference here.
    } catch (error) { throw error instanceof OcrError ? error : new OcrError("OCR.PROTOCOL"); }
  }
}
