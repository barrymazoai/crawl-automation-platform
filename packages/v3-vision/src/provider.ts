import { mkdir, lstat, realpath, open } from "node:fs/promises";
import { join } from "node:path";
import { CodexRpc, CodexError, CodexExecutionConfigSchema, codexConnection, assertCodexModel, runCodexTurn,
  codexWorkspace, finishCodexWorkspace,
  type CodexConnectionFactory } from "@crawl-automation/v3-codex";
import { ImageEvidenceSchema, type ArtifactRef } from "@crawl-automation/v3-contracts";
import { verifyBytes } from "@crawl-automation/v3-artifacts";
import { digest } from "./keywords.js";
import { z } from "zod";
import { labelExtractionVersion, labelValidationVersion } from "@crawl-automation/v3-contracts";
import { labelVisionPrompt, labelVisionOutputSchema, labelVisionPolicyVersion, labelVisionPromptV2, labelVisionOutputV2Schema } from "./label-extraction.js";
import { visionPrompt, visionOutputSchema, visionValidationVersion } from "./extraction.js";
export const CodexVisionConfigSchema = CodexExecutionConfigSchema.extend({
  extractionProtocol: z.enum(["label-extraction/1", "label-extraction/2"]).optional(),
});
export type CodexVisionConfig = z.infer<typeof CodexVisionConfigSchema>;
export interface VisionProvider {
  readonly fingerprint: string;
  readonly extractionProtocol?: "label-extraction/1" | "label-extraction/2" | undefined;
  interpret(image: ArtifactRef, bytes: Uint8Array, signal: AbortSignal): Promise<string>;
}
export class CodexVisionProvider implements VisionProvider {
  readonly fingerprint: string;
  readonly extractionProtocol?: "label-extraction/1" | "label-extraction/2" | undefined;
  private readonly active = new Set<CodexRpc>();
  private readonly stopped = new AbortController();
  private constructor(readonly config: Readonly<CodexVisionConfig>, private readonly environment: NodeJS.ProcessEnv,
    private readonly create: CodexConnectionFactory) {
    this.fingerprint = CodexVisionProvider.describe(config).configFingerprint;
    this.extractionProtocol = config.extractionProtocol;
  }
  static describe(raw: unknown) {
    const config = CodexVisionConfigSchema.parse(raw);
    if(config.extractionProtocol==="label-extraction/2")return{extractionProtocol:config.extractionProtocol,
      configFingerprint:digest(JSON.stringify(["codex-vision/3",config.settings,config.runtimeProfileVersion,config.timeoutMs,"original",config.extractionProtocol,"label-visual-quality/1",labelVisionPromptV2,labelVisionOutputV2Schema]))};
    if (config.extractionProtocol) return { extractionProtocol: config.extractionProtocol,
      configFingerprint: digest(JSON.stringify(["codex-vision/2", config.settings, config.runtimeProfileVersion,
        config.timeoutMs, "original", labelExtractionVersion, labelVisionPolicyVersion, labelValidationVersion,
        labelVisionPrompt, labelVisionOutputSchema])) };
    return { configFingerprint: digest(JSON.stringify(["codex-vision/1", config.settings, config.runtimeProfileVersion,
      config.timeoutMs, "original", visionPrompt, visionOutputSchema, visionValidationVersion])) };
  }
  static async open(raw: unknown, environment: NodeJS.ProcessEnv, create: CodexConnectionFactory = o => new CodexRpc(o)) {
    const config = CodexVisionConfigSchema.parse(raw);
    await mkdir(config.workRoot, { recursive: true, mode: 0o700 });
    for (const dir of [config.workRoot, config.codexHome]) {
      const s = await lstat(dir);
      if (!s.isDirectory() || s.isSymbolicLink() || (process.platform !== "win32" && (s.mode & 0o077))) throw Error("VISION.PRIVATE_CONFIG");
    }
    config.workRoot = await realpath(config.workRoot); config.codexHome = await realpath(config.codexHome);
    Object.freeze(config.settings);
    return new CodexVisionProvider(Object.freeze(config), { ...environment }, create);
  }
  private async connection(signal: AbortSignal) {
    signal.throwIfAborted();
    const cwd = await codexWorkspace(this.config.workRoot, "vision-");
    try {
      signal.throwIfAborted();
      const rpc = this.create(codexConnection(this.config, cwd, this.environment));
      this.active.add(rpc); return { rpc, cwd };
    } catch(error) { await finishCodexWorkspace(cwd); throw error; }
  }
  async check(signal: AbortSignal) {
    const lifetime = AbortSignal.any([signal, this.stopped.signal, AbortSignal.timeout(this.config.timeoutMs)]);
    const { rpc, cwd } = await this.connection(lifetime);
    try { await rpc.initialize(lifetime); await assertCodexModel(rpc, this.config.settings, cwd, lifetime, ["text", "image"]); }
    finally { await rpc.close(); this.active.delete(rpc); await finishCodexWorkspace(cwd); }
  }
  async interpret(rawImage: ArtifactRef, bytes: Uint8Array, signal: AbortSignal, onStopped?: () => void) {
    const image = ImageEvidenceSchema.parse(rawImage);
    verifyBytes(image, bytes, 16 * 1024 * 1024);
    const lifetime = AbortSignal.any([signal, this.stopped.signal, AbortSignal.timeout(this.config.timeoutMs)]);
    const { rpc, cwd } = await this.connection(lifetime);
    try {
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[image.mediaType];
      const path = join(cwd, `source.${ext}`), f = await open(path, "wx", 0o600);
      try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
      return await runCodexTurn(rpc, { ...this.config.settings, cwd,
        prompt: this.extractionProtocol === "label-extraction/2" ? labelVisionPromptV2 : this.extractionProtocol ? labelVisionPrompt : visionPrompt,
        outputSchema: this.extractionProtocol === "label-extraction/2" ? labelVisionOutputV2Schema : this.extractionProtocol ? labelVisionOutputSchema : visionOutputSchema,
        image: { path, detail: "original" } }, lifetime, this.config.timeoutMs);
    } catch (e) {
      throw e instanceof CodexError ? new CodexError(e.code.replace(/^TEXT\./, "VISION."), e.executionFact, e.detail) : e;
    } finally { await rpc.close(); this.active.delete(rpc); await finishCodexWorkspace(cwd); onStopped?.(); }
  }
  async close() { this.stopped.abort(); await Promise.all([...this.active].map(r => r.close())); }
}
