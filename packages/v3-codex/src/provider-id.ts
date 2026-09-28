// Codex reserves `openai`; it cannot accept per-provider retry overrides.
// This execution-only ID keeps OpenAI authentication and default endpoints.
// Business model settings/fingerprints remain unchanged; there is no fallback.
export const OPENAI_NO_RETRY = "crawler_openai_no_retry";
export const executionProvider = (provider: string) => provider === "openai" ? OPENAI_NO_RETRY : provider;
