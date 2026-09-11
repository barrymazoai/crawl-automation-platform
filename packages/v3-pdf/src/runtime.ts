import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactRefSchema, PdfInputSchema, PdfManifestSchema, PdfDataSchema, pdfFingerprintMaterial,
  type ArtifactRef, type PdfInput, type PdfManifest, type PdfData } from "@crawl-automation/v3-contracts";
import { sha256, verifyBytes } from "@crawl-automation/v3-artifacts";
import policy from "../policy.json";
import { PdfError } from "./errors.js";
import { runProcess } from "./process.js";

export const pdfConfigFingerprint: string = sha256(Buffer.from(JSON.stringify(policy)));
export const fingerprintPdfInput = (input: PdfInput): string => sha256(Buffer.from(pdfFingerprintMaterial(input)));
export interface PdfOptions { pythonExecutable: string; workRoot: string; assetRoot?: string }
export interface PdfPrepared {
  input: PdfInput; attemptId: string; manifest: PdfManifest; artifact: ArtifactRef; bytes: Uint8Array; data: PdfData | null;
  computedLocal: true; artifactDurable: false; resultRegistered: false;
}

export function inputChecked(raw: unknown): PdfInput {
  const parsed = PdfInputSchema.safeParse(raw);
  if (!parsed.success) throw new PdfError("PDF.INVALID_INPUT");
  const input = parsed.data;
  if (input.implementationVersion !== "1" || input.policyVersion !== "1" || input.configFingerprint !== pdfConfigFingerprint)
    throw new PdfError("PDF.ENGINE_MISMATCH");
  if (fingerprintPdfInput(input) !== input.inputFingerprint) throw new PdfError("PDF.INVALID_INPUT");
  if (input.pdf.byteSize > policy.maxInputBytes) throw new PdfError("PDF.INPUT_INTEGRITY");
  return input;
}
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw new PdfError("PDF.CANCELLED"); };
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function save(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function readBounded(path: string, limit: number): Promise<Buffer> {
  if ((await lstat(path)).isSymbolicLink()) throw new PdfError("PDF.RESULT_INTEGRITY");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit) throw new PdfError("PDF.RESULT_INTEGRITY");
    const buffer = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== info.size) throw new PdfError("PDF.RESULT_INTEGRITY");
    return buffer.subarray(0, used);
  } finally { await handle.close(); }
}
const parseJson = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

/** Local execution adapter, not an HTTP service or Temporal Worker. No automatic retries. */
export class PdfSubprocess {
  private constructor(private readonly options: PdfOptions) {}
  static async open(options: PdfOptions): Promise<PdfSubprocess> {
    if (!isAbsolute(options.pythonExecutable) || !isAbsolute(options.workRoot) || (options.assetRoot !== undefined && !isAbsolute(options.assetRoot))) throw new PdfError("PDF.INVALID_INPUT");
    await mkdir(options.workRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(options.workRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0))
      throw new PdfError("PDF.INVALID_INPUT");
    return new PdfSubprocess({ ...options, workRoot: await realpath(options.workRoot) });
  }
  async run(raw: unknown, source: Uint8Array, signal: AbortSignal, onAttempt?: (attemptId: string) => Promise<void>): Promise<PdfPrepared> {
    const input = inputChecked(raw);
    checkAbort(signal);
    if (!(source instanceof Uint8Array) || source.byteLength > policy.maxInputBytes) throw new PdfError("PDF.INPUT_INTEGRITY");
    // Snapshot caller-owned bytes before the first await; concurrent mutation cannot alter this attempt.
    const bytes = Buffer.from(source);
    try { verifyBytes(input.pdf, bytes, policy.maxInputBytes); } catch { throw new PdfError("PDF.INPUT_INTEGRITY"); }
    let attemptId: string | undefined;
    try {
      const dir = await mkdtemp(join(this.options.workRoot, "pdf-"));
      attemptId = basename(dir);
      await save(join(dir, "source.pdf"), bytes);
      await save(join(dir, "input.json"), Buffer.from(JSON.stringify(input)));
      await syncDirectory(dir);
      await syncDirectory(this.options.workRoot);
      // Persist operation → local attempt before Python can execute. A failed journal write prevents execution.
      await onAttempt?.(attemptId);
      checkAbort(signal);
      await runProcess({ executable: this.options.pythonExecutable,
        args: ["-I", this.options.assetRoot ? join(this.options.assetRoot, "python/worker.py") : fileURLToPath(new URL("../python/worker.py", import.meta.url))], cwd: dir,
        stdin: JSON.stringify(input), timeoutMs: policy.wallTimeoutMs, signal });
      return await this.inspectAttempt(input, attemptId, signal);
    } catch (error) {
      throw new PdfError(error instanceof PdfError ? error.code : "PDF.PROCESS_FAILED", attemptId);
    }
  }
  /** Read-only evidence recovery: never starts Python, uploads files or registers a result. */
  async inspectAttempt(raw: unknown, attemptId: string, signal: AbortSignal): Promise<PdfPrepared> {
    const input = inputChecked(raw);
    if (!/^pdf-[A-Za-z0-9]{6}$/.test(attemptId)) throw new PdfError("PDF.INVALID_INPUT");
    checkAbort(signal);
    try {
      const dir = join(this.options.workRoot, attemptId);
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new PdfError("PDF.RESULT_INTEGRITY");
      const saved = inputChecked(parseJson(await readBounded(join(dir, "input.json"), 65536)));
      if (JSON.stringify(saved) !== JSON.stringify(input)) throw new PdfError("PDF.RESULT_INTEGRITY");
      let completion: Buffer;
      try { completion = await readBounded(join(dir, "complete.json"), 65536); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PdfError("PDF.ATTEMPT_MISSING");
        throw error;
      }
      const manifest = PdfManifestSchema.parse(parseJson(completion));
      const render = input.module === "pdf.render";
      if (manifest.operationId !== input.operationId || manifest.inputFingerprint !== input.inputFingerprint ||
          manifest.sourceSha256 !== input.pdf.sha256 || manifest.module !== input.module ||
          manifest.pageIndex !== (input.module === "pdf.inspect" ? null : input.pageIndex) ||
          manifest.scale !== (render ? input.scale : null) || manifest.filename !== (render ? "output.png" : "output.json") ||
          manifest.engine.pypdfium2 !== policy.pypdfium2 || manifest.engine.pdfium !== policy.pdfium || manifest.engine.pillow !== policy.pillow)
        throw new PdfError("PDF.RESULT_INTEGRITY");
      const original = await readBounded(join(dir, "source.pdf"), policy.maxInputBytes);
      verifyBytes(input.pdf, original, policy.maxInputBytes);
      const bytes = await readBounded(join(dir, manifest.filename), policy.maxOutputBytes);
      if (sha256(bytes) !== manifest.sha256 || bytes.length !== manifest.byteSize) throw new PdfError("PDF.RESULT_INTEGRITY");
      let data: PdfData | null = null;
      if (render) {
        if (manifest.width === null || manifest.height === null || manifest.width * manifest.height > policy.maxPixels ||
            bytes.length < 33 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
            bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" ||
            bytes.readUInt32BE(16) !== manifest.width || bytes.readUInt32BE(20) !== manifest.height)
          throw new PdfError("PDF.RESULT_INTEGRITY");
      } else {
        if (manifest.width !== null || manifest.height !== null) throw new PdfError("PDF.RESULT_INTEGRITY");
        data = PdfDataSchema.parse(parseJson(bytes));
        if (input.module === "pdf.inspect") {
          if (data.kind !== "inspect" || data.pageCount !== data.pages.length || data.pages.some((p, n) => p.pageIndex !== n))
            throw new PdfError("PDF.RESULT_INTEGRITY");
        } else if (data.kind !== "text" || data.pageIndex !== input.pageIndex || data.hasText !== /[^ \t\r\n\f\v\u00a0]/u.test(data.text) ||
                   Buffer.byteLength(data.text) > policy.maxTextBytes || [...data.text].length > policy.maxTextChars)
          throw new PdfError("PDF.RESULT_INTEGRITY");
      }
      const common = { schemaVersion: 1, artifactId: `pdf-${input.inputFingerprint}`, observationId: input.observationId,
        sourceId: input.sourceId, listingId: input.listingId, variantId: input.variantId, sha256: manifest.sha256,
        byteSize: manifest.byteSize, objectKey: `v3/${input.observationId}/${input.operationId}/${input.inputFingerprint}/${manifest.filename}`,
        producer: { operationId: input.operationId, module: input.module, implementationVersion: input.implementationVersion } };
      const artifact = ArtifactRefSchema.parse(render ? { ...common, kind: "pdf-page", mediaType: "image/png", parentArtifactId: input.pdf.artifactId, pageIndex: input.pageIndex } :
        { ...common, kind: "result-json", mediaType: "application/json" });
      verifyBytes(artifact, bytes, policy.maxOutputBytes);
      checkAbort(signal);
      return { input, attemptId, manifest, artifact, bytes, data, computedLocal: true, artifactDurable: false, resultRegistered: false };
    } catch (error) {
      throw new PdfError(error instanceof PdfError ? error.code : "PDF.RESULT_INTEGRITY", attemptId);
    }
  }
}
