import { lstat, mkdir, realpath } from "node:fs/promises";
import {
  CodexExecutionConfigSchema,
  CodexRpc,
  assertCodexTextModel,
  codexConnection,
  codexWorkspace,
  finishCodexWorkspace,
  runCodexTextTurn,
  type CodexConnectionFactory,
} from "@crawl-automation/v3-codex";
import { z } from "zod";
import { textFailure } from "../errors.js";
import type { TextModel } from "../ports.js";
import { hashText } from "../results/text-record.js";
import { codexTextCompatibility } from "./text-settings.js";

export const CodexTextConfigSchema = CodexExecutionConfigSchema.extend({
  extractionProtocol: z.literal("label-extraction/1").optional(),
});
export type CodexTextConfig = z.infer<typeof CodexTextConfigSchema>;

const RUNTIME_PROFILE = "codex-owned-turn/2";
const defaultConnection: CodexConnectionFactory = (options) => new CodexRpc(options);

/** The text model through Codex: one owned process per call; no restart, resume, repair or fallback model. */
export class CodexTextModel implements TextModel {
  readonly provider = "codex-app-server/2";
  readonly supported;
  readonly policy = Object.freeze({
    executionRetries: 0 as const,
    internalModelRequests: "no-retries" as const,
    toolAccess: "runtime-profile" as const,
    modelFallback: false as const,
    networkSwitching: false as const,
  });
  private readonly active = new Set<CodexRpc>();
  private readonly stopped = new AbortController();
  private closed = false;

  private constructor(
    readonly config: Readonly<CodexTextConfig>,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly connect: CodexConnectionFactory,
  ) {
    const base = codexTextCompatibility(
      config.settings,
      RUNTIME_PROFILE,
      config.extractionProtocol,
    );
    const fingerprint = hashText(
      JSON.stringify([base.configFingerprint, config.runtimeProfileVersion, config.timeoutMs]),
    );
    this.supported = Object.freeze({ ...base, configFingerprint: fingerprint });
  }

  /** The compatibility a config would have, without opening anything. */
  static describe(raw: unknown) {
    return new CodexTextModel(CodexTextConfigSchema.parse(raw), {}, defaultConnection).supported;
  }

  static async open(raw: unknown, environment: NodeJS.ProcessEnv, connect = defaultConnection) {
    try {
      const config = CodexTextConfigSchema.parse(raw);
      await mkdir(config.workRoot, { recursive: true, mode: 0o700 });
      for (const directory of [config.workRoot, config.codexHome]) {
        await assertPrivateDirectory(directory);
      }
      config.workRoot = await realpath(config.workRoot);
      config.codexHome = await realpath(config.codexHome);
      Object.freeze(config.settings);
      return new CodexTextModel(Object.freeze(config), { ...environment }, connect);
    } catch {
      throw textFailure("TEXT.CODEX_PRIVATE_CONFIG", "not_executed");
    }
  }

  /** Startup capability check only: no thread, no model turn. */
  async check(signal: AbortSignal): Promise<void> {
    const lifetime = this.lifetime(signal);
    const { rpc, cwd } = await this.connection(lifetime);
    try {
      await rpc.initialize(lifetime);
      await assertCodexTextModel(rpc, this.config.settings, cwd, lifetime);
    } finally {
      await this.release(rpc, cwd);
    }
  }

  async interpret(
    request: Parameters<TextModel["interpret"]>[0],
    signal: AbortSignal,
    onStopped?: () => void,
  ) {
    const lifetime = this.lifetime(signal);
    const { rpc, cwd } = await this.connection(lifetime);
    try {
      const turn = {
        ...this.config.settings,
        cwd,
        prompt: request.prompt,
        outputSchema: request.outputSchema,
      };
      return await runCodexTextTurn(rpc, turn, lifetime, this.config.timeoutMs);
    } finally {
      await this.release(rpc, cwd);
      onStopped?.();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopped.abort();
    await Promise.all([...this.active].map((rpc) => rpc.close()));
  }

  private lifetime(signal: AbortSignal) {
    return AbortSignal.any([
      signal,
      this.stopped.signal,
      AbortSignal.timeout(this.config.timeoutMs),
    ]);
  }

  private async connection(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.closed) {
      throw textFailure("TEXT.CODEX_CLOSED", "not_executed");
    }
    const cwd = await codexWorkspace(this.config.workRoot, "execution-");
    try {
      signal.throwIfAborted();
      if (this.closed) {
        throw textFailure("TEXT.CODEX_CLOSED", "not_executed");
      }
      const rpc = this.connect(codexConnection(this.config, cwd, this.environment));
      this.active.add(rpc);
      return { rpc, cwd };
    } catch (error) {
      await finishCodexWorkspace(cwd);
      throw error;
    }
  }

  private async release(rpc: CodexRpc, cwd: string) {
    await rpc.close();
    this.active.delete(rpc);
    await finishCodexWorkspace(cwd);
  }
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  const shared = process.platform !== "win32" && (stat.mode & 0o077) !== 0;
  if (!stat.isDirectory() || stat.isSymbolicLink() || shared) {
    throw textFailure("TEXT.CODEX_PRIVATE_CONFIG", "not_executed");
  }
}
