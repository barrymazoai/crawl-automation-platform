import { mkdir, lstat, realpath } from "node:fs/promises";
import { z } from "zod";
import { CodexRpc } from "./codex-rpc.js";
import { runCodexTextTurn } from "./codex-turn.js";
import { assertCodexTextModel } from "./codex-preflight.js";
import { codexTextCompatibility } from "./codex-settings.js";
import { hashText } from "./handoff.js";
import { TextError, type TextProvider } from "./ports.js";

import { CodexExecutionConfigSchema, codexConnection as codexTextConnection,
  codexWorkspace, finishCodexWorkspace,
  type CodexConnectionFactory } from "@crawl-automation/v3-codex";
export { codexConnection as codexTextConnection, type CodexConnectionFactory, type CodexConnectionOptions } from "@crawl-automation/v3-codex";
export const CodexTextConfigSchema = CodexExecutionConfigSchema.extend({ extractionProtocol: z.literal("label-extraction/1").optional() });
export type CodexTextConfig = z.infer<typeof CodexTextConfigSchema>;

/** One independent owned process per interpret call; no restart, resume, repair, or model fallback loop. */
export class CodexTextProvider implements TextProvider {
  readonly provider = "codex-app-server/2";
  readonly supported;
  readonly policy = Object.freeze({ executionRetries: 0 as const, internalModelRequests: "no-retries" as const,
    toolAccess: "runtime-profile" as const, modelFallback: false as const, networkSwitching: false as const });
  private readonly active = new Set<CodexRpc>();
  private closed = false;
  private readonly stopped = new AbortController();
  private readonly environment: NodeJS.ProcessEnv;
  private constructor(readonly config: Readonly<CodexTextConfig>, environment: NodeJS.ProcessEnv,
    private readonly create: CodexConnectionFactory) {
    this.environment = { ...environment };
    const base = codexTextCompatibility(config.settings, "codex-owned-turn/2", config.extractionProtocol);
    this.supported = Object.freeze({ ...base, configFingerprint: hashText(JSON.stringify([
      base.configFingerprint, config.runtimeProfileVersion, config.timeoutMs])) });
  }
  static describe(raw: unknown) {
    const config = CodexTextConfigSchema.parse(raw);
    return new CodexTextProvider(config, {}, options => new CodexRpc(options)).supported;
  }
  static async open(raw: unknown, environment: NodeJS.ProcessEnv,
    create: CodexConnectionFactory = options => new CodexRpc(options)) {
    try {
      const config = CodexTextConfigSchema.parse(raw);
      await mkdir(config.workRoot, { recursive: true, mode: 0o700 });
      for (const directory of [config.workRoot, config.codexHome]) {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077))) throw Error();
      }
      config.workRoot = await realpath(config.workRoot);
      config.codexHome = await realpath(config.codexHome);
      Object.freeze(config.settings);
      return new CodexTextProvider(Object.freeze(config), environment, create);
    } catch { throw new TextError("TEXT.CODEX_PRIVATE_CONFIG", "not_executed"); }
  }
  private async connection(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.closed) throw new TextError("TEXT.CODEX_CLOSED", "not_executed");
    const cwd = await codexWorkspace(this.config.workRoot, "execution-");
    try {
      signal.throwIfAborted();
      if (this.closed) throw new TextError("TEXT.CODEX_CLOSED", "not_executed");
      const rpc = this.create(codexTextConnection(this.config, cwd, this.environment));
      this.active.add(rpc);
      return { rpc, cwd };
    } catch(error) { await finishCodexWorkspace(cwd); throw error; }
  }
  /** Startup capabilities only. No thread or model turn. */
  async check(signal: AbortSignal) {
    const lifetime = AbortSignal.any([signal, this.stopped.signal, AbortSignal.timeout(this.config.timeoutMs)]);
    const { rpc, cwd } = await this.connection(lifetime);
    try { await rpc.initialize(lifetime); await assertCodexTextModel(rpc, this.config.settings, cwd, lifetime); }
    finally { await rpc.close(); this.active.delete(rpc); await finishCodexWorkspace(cwd); }
  }
  async interpret(request: Parameters<TextProvider["interpret"]>[0], signal: AbortSignal, onStopped?: () => void) {
    const lifetime = AbortSignal.any([signal, this.stopped.signal, AbortSignal.timeout(this.config.timeoutMs)]);
    const { rpc, cwd } = await this.connection(lifetime);
    try { return await runCodexTextTurn(rpc, { ...this.config.settings, cwd, prompt: request.prompt, outputSchema: request.outputSchema }, lifetime, this.config.timeoutMs); }
    finally { await rpc.close(); this.active.delete(rpc); await finishCodexWorkspace(cwd); onStopped?.(); }
  }
  async close() {
    this.closed = true;
    this.stopped.abort();
    await Promise.all([...this.active].map(rpc => rpc.close()));
  }
}
