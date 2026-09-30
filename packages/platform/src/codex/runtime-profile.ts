import { z } from "zod";
import { CodexModelSettingsSchema } from "@crawl-automation/v3-contracts";
import { codexFailure } from "./errors.js";
import { executionProvider, OPENAI_NO_RETRY } from "./provider-id.js";

const effectiveConfig = z.object({
  config: z.object({
    model_provider: CodexModelSettingsSchema.shape.provider,
    openai_base_url: z.unknown().optional(),
    model_providers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    mcp_servers: z.record(z.string(), z.object({ enabled: z.boolean().optional() })).optional(),
  }),
});

const required = {
  name: "OpenAI",
  wire_api: "responses",
  requires_openai_auth: true,
  supports_websockets: false,
  request_max_retries: 0,
  stream_max_retries: 0,
};
const forbidden = [
  "base_url",
  "env_key",
  "experimental_bearer_token",
  "auth",
  "aws",
  "query_params",
  "http_headers",
  "env_http_headers",
];

function assertNoRetryProfile(config: z.infer<typeof effectiveConfig>["config"]): void {
  const provider = config.model_providers?.[OPENAI_NO_RETRY];
  const invalid =
    !provider || Object.entries(required).some(([key, value]) => provider[key] !== value);
  if (
    invalid ||
    config.openai_base_url != null ||
    forbidden.some((key) => provider?.[key] != null)
  ) {
    throw codexFailure("TEXT.CODEX_NO_RETRY_PROFILE", "not_executed");
  }
}

export function assertRuntimeProfile(raw: unknown, provider: string): void {
  const { config } = effectiveConfig.parse(raw);
  if (config.model_provider !== executionProvider(provider)) {
    throw codexFailure("TEXT.CODEX_CATALOG_PROVIDER_MISMATCH", "not_executed");
  }
  if (provider === "openai") {
    assertNoRetryProfile(config);
  }
  if (Object.values(config.mcp_servers ?? {}).some((server) => server.enabled !== false)) {
    throw codexFailure("TEXT.CODEX_RUNTIME_PROFILE", "not_executed");
  }
}
