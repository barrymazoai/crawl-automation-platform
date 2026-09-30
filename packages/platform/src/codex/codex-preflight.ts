import { withCause } from "../errors/with-cause.js";
import { CodexModelSettingsSchema, type CodexModelSettings } from "@crawl-automation/v3-contracts";
import type { CodexRpc } from "./codex-rpc.js";
import { CodexError, codexFailure } from "./errors.js";
import { assertCatalog, type CodexModality } from "./catalog.js";
import { assertRuntimeProfile } from "./runtime-profile.js";

export interface CodexPreflightOptions {
  cwd: string;
  signal: AbortSignal;
  modalities?: readonly CodexModality[];
}

/** Catalog claims only: no thread/turn, config writes, entitlement probe, defaults or fallback. */
export async function assertCodexModel(
  rpc: Pick<CodexRpc, "request">,
  raw: CodexModelSettings,
  options: CodexPreflightOptions,
): Promise<void> {
  try {
    const settings = CodexModelSettingsSchema.parse(raw);
    const { cwd, signal, modalities = ["text"] } = options;
    signal.throwIfAborted();
    const config = await rpc.request("config/read", { includeLayers: false, cwd }, signal);
    assertRuntimeProfile(config, settings.provider);
    await assertCatalog(rpc, settings, { signal, modalities });
  } catch (error) {
    // Raw catalog/config/remote error bodies can contain private configuration.
    if (error instanceof CodexError) {
      throw withCause(new CodexError(error.code, "not_executed"), error);
    }
    throw withCause(codexFailure("TEXT.CODEX_PREFLIGHT_INVALID", "not_executed"), error);
  }
}
