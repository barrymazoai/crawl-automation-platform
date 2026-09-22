import { describe, expect, it } from "vitest";
import { CodexError, describeCodexError } from "./errors.js";
import { runCodexTurn } from "./codex-turn.js";
import type { CodexRpc } from "./codex-rpc.js";

describe("what Codex said went wrong", () => {
  it("keeps the message and the machine-readable kind", () => {
    expect(describeCodexError({ message: "stream disconnected before completion", codexErrorInfo: "responseStreamDisconnected" }))
      .toBe("stream disconnected before completion | responseStreamDisconnected");
    expect(describeCodexError({ message: "unexpected status 429", codexErrorInfo: { usageLimitExceeded: { resetsAt: 1 } } }))
      .toBe('unexpected status 429 | {"usageLimitExceeded":{"resetsAt":1}}');
  });
  it("never carries a credential", () => {
    const d = describeCodexError({ message: "401 Unauthorized: Bearer eyJabc.def123456.ghi789012 rejected; api_key=sk-live-123456789 token: abcdef" })!;
    expect(d).not.toMatch(/eyJabc|sk-live|abcdef/);
    expect(d).toContain("Bearer [redacted]");
    expect(d).toContain("api_key=[redacted]");
  });
  it("is bounded, and absent when there is nothing to say", () => {
    expect(describeCodexError({ message: "x".repeat(5000) })).toHaveLength(500);
    expect(describeCodexError(undefined)).toBeUndefined();
    expect(describeCodexError(null)).toBeUndefined();
    expect(describeCodexError(42)).toBeUndefined();
  });
});

/** An app-server that answers the preflight and thread start, then fails the turn the way it is told to. */
function fakeRpc(fail: (notify: (method: string, params: unknown) => void) => void): CodexRpc {
  const listeners = new Set<(m: { method?: string; params?: unknown }) => void>();
  const notify = (method: string, params: unknown) => { for (const l of listeners) l({ method, params }); };
  return {
    initialize: async () => {},
    onFailure: () => () => {},
    onNotification: (l: (m: { method?: string; params?: unknown }) => void) => { listeners.add(l); return () => listeners.delete(l); },
    close: async () => {},
    request: async (method: string) => {
      if (method === "config/read") return { config: { model_provider: "openai", mcp_servers: {} } };
      if (method === "model/list") return { data: [{ id: "m", model: "gpt-5.6-luna", supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        inputModalities: ["text", "image"] }], nextCursor: null };
      if (method === "thread/start") return { thread: { id: "t1" }, model: "gpt-5.6-luna", modelProvider: "openai", cwd: "/w",
        approvalPolicy: "never", sandbox: { type: "readOnly" }, reasoningEffort: "medium" };
      if (method === "turn/start") { setTimeout(() => fail(notify), 0); return { turn: { id: "u1" } }; }
      throw Error("unexpected " + method);
    },
  } as unknown as CodexRpc;
}
const turn = (rpc: CodexRpc) => runCodexTurn(rpc, { model: "gpt-5.6-luna", provider: "openai", reasoningEffort: "medium",
  cwd: "/w", prompt: "p", outputSchema: {} }, new AbortController().signal, 5000);

describe("a failed turn keeps its reason", () => {
  it("from an error notification Codex will not retry", async () => {
    const error = await turn(fakeRpc(n => n("error", { threadId: "t1", turnId: "u1", willRetry: false,
      error: { message: "unexpected status 401 Unauthorized", codexErrorInfo: "unauthorized" } }))).catch(e => e);
    expect(error).toBeInstanceOf(CodexError);
    expect(error).toMatchObject({ code: "TEXT.CODEX_TURN_FAILED", detail: "unexpected status 401 Unauthorized | unauthorized" });
  });
  it("from a turn that completed as failed", async () => {
    const error = await turn(fakeRpc(n => {
      n("turn/started", { threadId: "t1", turn: { id: "u1" } });
      n("turn/completed", { threadId: "t1", turn: { id: "u1", status: "failed", error: { message: "database is locked" } } });
    })).catch(e => e);
    expect(error).toMatchObject({ code: "TEXT.CODEX_TURN_FAILED", detail: "database is locked" });
  });
  it("and an internal retry is still not a failure", async () => {
    const error = await turn(fakeRpc(n => {
      n("error", { threadId: "t1", willRetry: true, error: { message: "reconnecting" } });
      n("turn/completed", { threadId: "t1", turn: { id: "u1", status: "failed", error: { message: "gave up" } } });
    })).catch(e => e);
    expect(error.detail).toBe("gave up");
  });
});
