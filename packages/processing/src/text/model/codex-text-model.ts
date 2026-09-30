import {
  CodexExecutionConfigSchema,
  type CodexConnectionFactory,
} from "@crawl-automation/platform";
import { z } from "zod";
import { CodexClient } from "../../codex/codex-client.js";
import type { CodexModelProfile } from "../../codex/codex-profile.js";
import { textFailure } from "../errors.js";
import type { TextModel } from "../ports.js";
import { hashText } from "../results/text-record.js";
import { codexTextCompatibility } from "./text-settings.js";

export const CodexTextConfigSchema = CodexExecutionConfigSchema.extend({
  extractionProtocol: z.literal("label-extraction/1").optional(),
});
export type CodexTextConfig = z.infer<typeof CodexTextConfigSchema>;

const RUNTIME_PROFILE = "codex-owned-turn/2";

/** Text keeps Codex's own `TEXT.CODEX_*` codes. */
const textProfile: CodexModelProfile = {
  workspace: "execution-",
  modalities: ["text"],
  renameError: (error) => error,
  privateConfig: () => textFailure("TEXT.CODEX_PRIVATE_CONFIG", "not_executed"),
  closed: () => textFailure("TEXT.CODEX_CLOSED", "not_executed"),
};

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

  private constructor(
    readonly config: Readonly<CodexTextConfig>,
    private readonly client: CodexClient | null,
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
    return new CodexTextModel(CodexTextConfigSchema.parse(raw), null).supported;
  }

  static async open(
    raw: unknown,
    environment: NodeJS.ProcessEnv,
    connect?: CodexConnectionFactory,
  ) {
    const parsed = CodexTextConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw textProfile.privateConfig();
    }
    const { extractionProtocol, ...settings } = parsed.data;
    const client = await CodexClient.open(settings, {
      environment,
      profile: textProfile,
      ...(connect ? { connect } : {}),
    });
    const config = { ...client.settings, ...(extractionProtocol ? { extractionProtocol } : {}) };
    return new CodexTextModel(Object.freeze(config), client);
  }

  /** Startup capability check only: no thread, no model turn. */
  async check(signal: AbortSignal): Promise<void> {
    await this.opened().check(signal);
  }

  async interpret(
    request: Parameters<TextModel["interpret"]>[0],
    signal: AbortSignal,
    onStopped?: () => void,
  ) {
    const call = { prompt: request.prompt, outputSchema: request.outputSchema };
    return this.opened().run(call, signal, onStopped);
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  private opened(): CodexClient {
    if (!this.client) {
      throw textProfile.closed();
    }
    return this.client;
  }
}
