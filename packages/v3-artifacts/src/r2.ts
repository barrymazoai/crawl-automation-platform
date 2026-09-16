import { GetObjectCommand, PutObjectCommand, S3Client, type GetObjectCommandOutput, type PutObjectCommandOutput } from "@aws-sdk/client-s3";
import { ObjectKeySchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { Readable } from "node:stream";
import { ArtifactError, type ObjectStore } from "./ports.js";

export const R2ScopeSchema = z.strictObject({
  endpoint: z.string().regex(/^https:\/\/[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  prefix: ObjectKeySchema.refine(key => key.includes("/"), "Explicit scoped prefix required"),
  timeoutMs: z.number().int().min(100).max(120000).default(30000),
  // Transient transport failures (connection resets, TLS aborts, 5xx/429) are retried this many extra times with
  // 0.5s/1.5s/3s backoff; each attempt has its own timeout. Keys are immutable, so a repeated PUT is harmless.
  retries: z.number().int().min(0).max(5).optional(),
});
export type R2Scope = z.infer<typeof R2ScopeSchema>;
export interface R2ClientPort {
  send(command: GetObjectCommand, options: { abortSignal: AbortSignal }): Promise<GetObjectCommandOutput>;
  send(command: PutObjectCommand, options: { abortSignal: AbortSignal }): Promise<PutObjectCommandOutput>;
}
const status = (error: unknown) => error && typeof error === "object" && "$metadata" in error
  ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode : undefined;
// Do not retain SDK messages, endpoints, headers, credentials or arbitrary cause objects.
function diagnostics(raw:unknown){
  const e=raw as {name?:unknown;code?:unknown;$metadata?:{httpStatusCode?:unknown;requestId?:unknown}};
  const token=(v:unknown,re:RegExp)=>typeof v==='string'&&re.test(v)?v:undefined;
  return Object.fromEntries(Object.entries({name:token(e?.name,/^[A-Za-z]{1,50}$/),code:token(e?.code,/^[A-Z_0-9]{1,50}$/),
    status:typeof e?.$metadata?.httpStatusCode==='number'?e.$metadata.httpStatusCode:undefined,
    requestId:token(e?.$metadata?.requestId,/^[a-zA-Z0-9-]{1,128}$/)}).filter(([,value])=>value!==undefined));
}

/** Fresh SigV4 request per read; no persisted presigned URL or URL renewal loop. */
export class R2Objects implements ObjectStore {
  private readonly scope: R2Scope;
  constructor(private readonly client: R2ClientPort, scope: R2Scope) { this.scope = R2ScopeSchema.parse(scope); }
  private key(key: string) { return ObjectKeySchema.parse(`${this.scope.prefix}/${ObjectKeySchema.parse(key)}`); }
  private signal(signal: AbortSignal) { return AbortSignal.any([signal, AbortSignal.timeout(this.scope.timeoutMs)]); }
  /** Retry only what the transport lost: never a decided answer (404, 412, size limit) and never after the caller aborted. */
  private async attempt<T>(signal: AbortSignal, once: () => Promise<T>): Promise<T> {
    for (let n = 0; ; n++) {
      try { return await once(); }
      catch (error) {
        signal.throwIfAborted();
        const code = status(error), transient = !(error instanceof ArtifactError) && (code === undefined || code === 429 || code >= 500);
        if (!transient || n >= (this.scope.retries ?? 3)) throw error;
        await new Promise(r => setTimeout(r, [500, 1500, 3000][Math.min(n, 2)]));
      }
    }
  }
  async read(key: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ArtifactError("ARTIFACT.TOO_LARGE");
    try { return await this.attempt(signal, () => this.readOnce(key, maxBytes, signal)); }
    catch (error) { signal.throwIfAborted(); if (error instanceof ArtifactError) throw error; throw new ArtifactError("ARTIFACT.UNAVAILABLE", diagnostics(error)); }
  }
  private async readOnce(key: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
    const scopedKey = this.key(key), bounded = this.signal(signal);
    bounded.throwIfAborted();
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.scope.bucket, Key: scopedKey }), { abortSignal: bounded });
      const body = response.Body;
      if (!(body instanceof Readable)) throw new ArtifactError("ARTIFACT.UNAVAILABLE");
      const chunks: Buffer[] = []; let size = 0;
      const abort = () => body.destroy(new ArtifactError("ARTIFACT.UNAVAILABLE"));
      bounded.addEventListener("abort", abort, { once: true });
      try {
        if (bounded.aborted) abort();
        if (response.ContentLength !== undefined && response.ContentLength > maxBytes) {
          body.destroy(); throw new ArtifactError("ARTIFACT.TOO_LARGE");
        }
        for await (const chunk of body as AsyncIterable<unknown>) {
          bounded.throwIfAborted();
          if (!(chunk instanceof Uint8Array)) throw new ArtifactError("ARTIFACT.UNAVAILABLE");
          size += chunk.byteLength;
          if (size > maxBytes) throw new ArtifactError("ARTIFACT.TOO_LARGE");
          chunks.push(Buffer.from(chunk));
        }
      } finally {
        bounded.removeEventListener("abort", abort);
        body.destroy();
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ArtifactError) throw error;
      if (status(error) === 404 && error instanceof Error && error.name === "NoSuchKey") return null;
      throw error;
    }
  }
  async create(key: string, bytes: Uint8Array, mediaType: string, signal: AbortSignal): Promise<"created" | "exists"> {
    try { return await this.attempt(signal, () => this.createOnce(key, bytes, mediaType, signal)); }
    catch (error) { signal.throwIfAborted(); if (error instanceof ArtifactError) throw error; throw new ArtifactError("ARTIFACT.UPLOAD_UNKNOWN", diagnostics(error)); }
  }
  private async createOnce(key: string, bytes: Uint8Array, mediaType: string, signal: AbortSignal): Promise<"created" | "exists"> {
    const scopedKey = this.key(key), bounded = this.signal(signal);
    bounded.throwIfAborted();
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.scope.bucket, Key: scopedKey,
        Body: bytes, ContentLength: bytes.byteLength, ContentType: mediaType, IfNoneMatch: "*" }), { abortSignal: bounded });
      return "created";
    } catch (error) {
      signal.throwIfAborted();
      if (status(error) === 412) return "exists";
      throw error;
    }
  }
}

export function createR2Objects(raw: R2Scope, credentials: { accessKeyId: string; secretAccessKey: string }) {
  const scope = R2ScopeSchema.parse(raw);
  const auth = z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }).parse(credentials);
  const client = new S3Client({ endpoint: scope.endpoint, region: "auto", credentials: auth, maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", forcePathStyle: true });
  return { store: new R2Objects(client, scope), close: () => client.destroy() };
}
