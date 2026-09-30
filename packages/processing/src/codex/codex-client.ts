import {
  CodexError,
  CodexRpc,
  assertCodexModel,
  codexConnection,
  codexWorkspace,
  finishCodexWorkspace,
  type CodexConnectionFactory,
} from "@crawl-automation/platform";
import type { CodexModelProfile } from "./codex-profile.js";
import { privateSettings, type CodexClientSettings } from "./codex-settings.js";
import { runOwnedTurn, type CodexCall } from "./codex-turn.js";

const defaultConnection: CodexConnectionFactory = (options) => new CodexRpc(options);

/**
 * Codex through its app-server, shared by the text and vision models: one owned process and one disposable working
 * directory per call; no restart, resume, repair or fallback model. Closing cancels every call in flight.
 */
export class CodexClient {
  private readonly active = new Set<CodexRpc>();
  private readonly stopped = new AbortController();
  private closed = false;

  private constructor(
    readonly settings: Readonly<CodexClientSettings>,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly setup: { profile: CodexModelProfile; connect: CodexConnectionFactory },
  ) {}

  static async open(
    raw: unknown,
    options: {
      environment: NodeJS.ProcessEnv;
      profile: CodexModelProfile;
      connect?: CodexConnectionFactory;
    },
  ): Promise<CodexClient> {
    let settings: CodexClientSettings;
    try {
      settings = await privateSettings(raw);
    } catch (cause) {
      const error = options.profile.privateConfig();
      error.cause = cause;
      throw error;
    }
    const setup = { profile: options.profile, connect: options.connect ?? defaultConnection };
    return new CodexClient(Object.freeze(settings), { ...options.environment }, setup);
  }

  /** Startup capability check only: no thread, no model turn. */
  async check(signal: AbortSignal): Promise<void> {
    const lifetime = this.lifetime(signal);
    await this.withConnection(lifetime, async ({ rpc, cwd }) => {
      await rpc.initialize(lifetime);
      const { settings } = this.settings;
      await assertCodexModel(rpc, settings, {
        cwd,
        signal: lifetime,
        modalities: this.setup.profile.modalities,
      });
    });
  }

  async run(call: CodexCall, signal: AbortSignal, onStopped?: () => void): Promise<string> {
    const lifetime = this.lifetime(signal);
    try {
      return await this.withConnection(lifetime, ({ rpc, cwd }) =>
        runOwnedTurn({ rpc, cwd, settings: this.settings }, call, lifetime),
      );
    } catch (error) {
      throw error instanceof CodexError ? this.setup.profile.renameError(error) : error;
    } finally {
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
      AbortSignal.timeout(this.settings.timeoutMs),
    ]);
  }

  /** One owned connection in its own working directory, always closed and removed afterwards. */
  private async withConnection<T>(
    signal: AbortSignal,
    use: (owned: { rpc: CodexRpc; cwd: string }) => Promise<T>,
  ): Promise<T> {
    this.assertOpen(signal);
    const cwd = await codexWorkspace(this.settings.workRoot, this.setup.profile.workspace);
    let rpc: CodexRpc | null = null;
    try {
      this.assertOpen(signal);
      rpc = this.setup.connect(codexConnection(this.settings, cwd, this.environment));
      this.active.add(rpc);
      return await use({ rpc, cwd });
    } finally {
      if (rpc) {
        await rpc.close();
        this.active.delete(rpc);
      }
      await finishCodexWorkspace(cwd);
    }
  }

  private assertOpen(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.closed) {
      throw this.setup.profile.closed();
    }
  }
}
