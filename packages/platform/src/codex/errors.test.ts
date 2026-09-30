import { describe, expect, it } from "vitest";
import { CodexError } from "./errors.js";
import { describeCodexError } from "./error-detail.js";
import { runCodexTurn } from "./codex-turn.js";
import type { CodexRpc } from "./codex-rpc.js";

describe("what Codex said went wrong", () => {
  it("keeps the message and the machine-readable kind", () => {
    expect(
      describeCodexError({
        message: "stream disconnected before completion",
        codexErrorInfo: "responseStreamDisconnected",
      }),
    ).toBe("stream disconnected before completion | responseStreamDisconnected");
    expect(
      describeCodexError({
        message: "unexpected status 429",
        codexErrorInfo: { usageLimitExceeded: { resetsAt: 1 } },
      }),
    ).toBe('unexpected status 429 | {"usageLimitExceeded":{"resetsAt":1}}');
  });
  it("never carries a credential", () => {
    const detail = describeCodexError({
      message:
        "401 Unauthorized: Bearer eyJabc.def123456.ghi789012 rejected; " +
        "api_key=sk-live-123456789 token: abcdef",
    });
    expect(detail).not.toMatch(/eyJabc|sk-live|abcdef/);
    expect(detail).toContain("Bearer [redacted]");
    expect(detail).toContain("api_key=[redacted]");
  });
  it("is bounded, and absent when there is nothing to say", () => {
    expect(describeCodexError({ message: "x".repeat(5000) })).toHaveLength(500);
    expect(describeCodexError(undefined)).toBeUndefined();
    expect(describeCodexError(null)).toBeUndefined();
    expect(describeCodexError(42)).toBeUndefined();
  });
});

/** Answers preflight and thread start, then fails the turn as instructed. */
function fakeRpc(fail: (notify: (method: string, params: unknown) => void) => void): CodexRpc {
  const listeners = new Set<(message: { method?: string; params?: unknown }) => void>();
  const notify = (method: string, params: unknown) => {
    for (const listener of listeners) {
      listener({ method, params });
    }
  };
  return {
    initialize: async () => {},
    onFailure: () => () => {},
    onNotification: (listener: (message: { method?: string; params?: unknown }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => {},
    request: async (method: string) => {
      if (method === "config/read") {
        return {
          config: {
            model_provider: "crawler_openai_no_retry",
            mcp_servers: {},
            model_providers: {
              crawler_openai_no_retry: {
                name: "OpenAI",
                wire_api: "responses",
                requires_openai_auth: true,
                supports_websockets: false,
                request_max_retries: 0,
                stream_max_retries: 0,
              },
            },
          },
        };
      }
      if (method === "model/list") {
        return {
          data: [
            {
              id: "message",
              model: "fixture-model",
              supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
              inputModalities: ["text", "image"],
            },
          ],
          nextCursor: null,
        };
      }
      if (method === "thread/start") {
        return {
          thread: { id: "t1" },
          model: "fixture-model",
          modelProvider: "crawler_openai_no_retry",
          cwd: "/w",
          approvalPolicy: "never",
          sandbox: { type: "readOnly" },
          reasoningEffort: "medium",
        };
      }
      if (method === "turn/start") {
        setTimeout(() => fail(notify), 0);
        return { turn: { id: "u1" } };
      }
      throw Error("unexpected " + method);
    },
  } as unknown as CodexRpc;
}
const turn = (rpc: CodexRpc) =>
  runCodexTurn(
    rpc,
    {
      model: "fixture-model",
      provider: "openai",
      reasoningEffort: "medium",
      cwd: "/w",
      prompt: "p",
      outputSchema: {},
    },
    { signal: new AbortController().signal, timeoutMs: 5000 },
  );

describe("a failed turn keeps its reason", () => {
  it("from an error notification Codex will not retry", async () => {
    const error = await turn(
      fakeRpc((notify) =>
        notify("error", {
          threadId: "t1",
          turnId: "u1",
          willRetry: false,
          error: { message: "unexpected status 401 Unauthorized", codexErrorInfo: "unauthorized" },
        }),
      ),
    ).catch((error) => error);
    expect(error).toBeInstanceOf(CodexError);
    expect(error).toMatchObject({
      code: "TEXT.CODEX_TURN_FAILED",
      detail: "unexpected status 401 Unauthorized | unauthorized",
    });
  });
  it("from a turn that completed as failed", async () => {
    const error = await turn(
      fakeRpc((notify) => {
        notify("turn/started", { threadId: "t1", turn: { id: "u1" } });
        notify("turn/completed", {
          threadId: "t1",
          turn: { id: "u1", status: "failed", error: { message: "database is locked" } },
        });
      }),
    ).catch((error) => error);
    expect(error).toMatchObject({ code: "TEXT.CODEX_TURN_FAILED", detail: "database is locked" });
  });
  it("an internal retry notification ends the call immediately", async () => {
    const error = await turn(
      fakeRpc((notify) => {
        notify("error", { threadId: "t1", willRetry: true, error: { message: "reconnecting" } });
        notify("turn/completed", {
          threadId: "t1",
          turn: { id: "u1", status: "failed", error: { message: "gave up" } },
        });
      }),
    ).catch((error) => error);
    expect(error.detail).toBe("reconnecting");
  });
});
