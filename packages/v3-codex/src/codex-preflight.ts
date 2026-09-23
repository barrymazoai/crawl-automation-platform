import { z } from "zod";
import { CodexModelSettingsSchema, type CodexModelSettings } from "@crawl-automation/v3-contracts";
import type { CodexRpc } from "./codex-rpc.js";
import { TextError } from "./errors.js";
import { executionProvider, OPENAI_NO_RETRY } from "./provider-id.js";

const token = z.string().min(1).max(200);
const model = z.object({
  id: token,
  model: CodexModelSettingsSchema.shape.model,
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: CodexModelSettingsSchema.shape.reasoningEffort })).max(50),
  // Unknown/older catalogs must not silently attest text support.
  inputModalities: z.array(token).max(20),
});
const page = z.object({ data: z.array(model).max(100), nextCursor: z.string().min(1).max(4096).nullable() });
const effectiveConfig = z.object({ config: z.object({ model_provider: CodexModelSettingsSchema.shape.provider,
  openai_base_url: z.unknown().optional(),
  model_providers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  mcp_servers: z.record(z.string(), z.object({ enabled: z.boolean().optional() })).optional() }) });

/** Read-only preflight on an initialized, exclusively owned connection.
 * This checks catalog claims, NOT account entitlement, quota, or tools=false admission.
 * No thread/turn, config writes, model probing, defaults, aliases, or fallback.
 */
export async function assertCodexModel(rpc: Pick<CodexRpc, "request">, raw: CodexModelSettings,
  cwd: string, signal: AbortSignal, modalities: readonly ("text" | "image")[] = ["text"]): Promise<void> {
  try {
    const settings = CodexModelSettingsSchema.parse(raw);
    signal.throwIfAborted();
    const config = effectiveConfig.parse(await rpc.request("config/read", { includeLayers: false, cwd }, signal));
    if (config.config.model_provider !== executionProvider(settings.provider))
      throw new TextError("TEXT.CODEX_CATALOG_PROVIDER_MISMATCH", "not_executed");
    if (settings.provider === "openai") {
      const p = config.config.model_providers?.[OPENAI_NO_RETRY];
      if (!p || p.name !== "OpenAI" || p.wire_api !== "responses" || p.requires_openai_auth !== true ||
          p.supports_websockets !== false || p.request_max_retries !== 0 || p.stream_max_retries !== 0 ||
          config.config.openai_base_url != null ||
          ["base_url", "env_key", "experimental_bearer_token", "auth", "aws", "query_params", "http_headers", "env_http_headers"]
            .some(key => p[key] != null))
        throw new TextError("TEXT.CODEX_NO_RETRY_PROFILE", "not_executed");
    }
    if (Object.values(config.config.mcp_servers ?? {}).some(server => server.enabled !== false))
      throw new TextError("TEXT.CODEX_RUNTIME_PROFILE", "not_executed");

    let cursor: string | null = null;
    let match: z.infer<typeof model> | undefined;
    const cursors = new Set<string>();
    for (let count = 0; count < 20; count++) {
      signal.throwIfAborted();
      const result = page.parse(await rpc.request("model/list", { cursor, limit: 100, includeHidden: true }, signal));
      for (const entry of result.data) {
        // id/displayName/upgrade/isDefault are not replacements for the wire model name.
        if (entry.model !== settings.model) continue;
        if (match) throw new TextError("TEXT.CODEX_CATALOG_AMBIGUOUS", "not_executed");
        match = entry;
      }
      if (result.nextCursor === null) {
        if (!match) throw new TextError("TEXT.CODEX_MODEL_UNAVAILABLE", "not_executed");
        for (const modality of modalities) if (!match.inputModalities.includes(modality))
          throw new TextError(`TEXT.CODEX_${modality.toUpperCase()}_UNSUPPORTED`, "not_executed");
        if (!match.supportedReasoningEfforts.some(option => option.reasoningEffort === settings.reasoningEffort))
          throw new TextError("TEXT.CODEX_EFFORT_UNSUPPORTED", "not_executed");
        signal.throwIfAborted();
        return;
      }
      if (cursors.has(result.nextCursor))
        throw new TextError("TEXT.CODEX_CATALOG_CURSOR_LOOP", "not_executed");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new TextError("TEXT.CODEX_CATALOG_LIMIT", "not_executed");
  } catch (error) {
    // Never surface raw catalog/config/remote error bodies (they may contain private config).
    throw new TextError(error instanceof TextError ? error.code : "TEXT.CODEX_PREFLIGHT_INVALID", "not_executed");
  }
}

export const assertCodexTextModel = assertCodexModel;
