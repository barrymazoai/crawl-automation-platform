// The reserved OpenAI provider cannot accept retry overrides. This ID retains its auth/endpoints.
export const OPENAI_NO_RETRY = "crawler_openai_no_retry";
export const executionProvider = (provider: string) =>
  provider === "openai" ? OPENAI_NO_RETRY : provider;
