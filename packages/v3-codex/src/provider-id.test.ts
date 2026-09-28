import { expect, it } from "vitest";
import { assertCodexModel } from "./codex-preflight.js";
import { executionProvider, OPENAI_NO_RETRY } from "./provider-id.js";
const settings = { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "medium" as const };
const profile = { name: "OpenAI", wire_api: "responses", requires_openai_auth: true,
  supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 };
it("keeps explicit custom providers and maps only the reserved OpenAI ID", () => {
  expect(executionProvider("fixture")).toBe("fixture");
  expect(executionProvider("openai")).toBe(OPENAI_NO_RETRY);
});
it.each([{ request_max_retries: 4 }, { stream_max_retries: 5 }, { supports_websockets: true },
  { base_url: "https://other.invalid" }, { env_key: "OTHER_KEY" }, { http_headers: { Authorization: "fixture" } }])(
  "rejects unsafe inherited execution settings before catalog or model work: %o", async override => {
    const calls: string[] = [];
    const rpc = { request: async (method: string) => { calls.push(method); return { config: {
      model_provider: OPENAI_NO_RETRY, model_providers: { [OPENAI_NO_RETRY]: { ...profile, ...override } }
    } }; } };
    await expect(assertCodexModel(rpc, settings, "/work", AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: "TEXT.CODEX_NO_RETRY_PROFILE" });
    expect(calls).toEqual(["config/read"]);
  });
