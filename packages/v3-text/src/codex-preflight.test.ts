import { expect, it } from "vitest";
import { assertCodexTextModel } from "./codex-preflight.js";
import { TextError } from "./ports.js";

const settings = { provider: "fixture", model: "exact-model", reasoningEffort: "high" };
const entry = { id: "picker-id", model: settings.model, supportedReasoningEfforts: [{ reasoningEffort: "high" }], inputModalities: ["text"] };
const done = (data: unknown[] = [entry]) => ({ data, nextCursor: null });
function connection(pages: unknown[] = [done()], provider = "fixture", mcpServers?: unknown) {
  const calls: { method: string; params: unknown }[] = [];
  let index = 0;
  return { calls, async request(method: string, params: unknown) {
    calls.push({ method, params });
    if (method === "config/read") return { config: { model_provider: provider, private_secret: "do-not-return", mcp_servers: mcpServers } };
    if (method !== "model/list") throw Error("Unexpected write/model operation");
    const value = pages[index++];
    if (value instanceof Error) throw value;
    return value;
  } };
}
const run = (rpc: ReturnType<typeof connection>, override = settings, signal = new AbortController().signal) =>
  assertCodexTextModel(rpc, override, "/private/worker", signal);

it("reads effective provider and the complete paginated hidden-inclusive catalog before accepting an exact model", async () => {
  const rpc = connection([{ data: [], nextCursor: "page-2" }, done()]);
  await run(rpc);
  expect(rpc.calls).toEqual([
    { method: "config/read", params: { includeLayers: false, cwd: "/private/worker" } },
    { method: "model/list", params: { cursor: null, limit: 100, includeHidden: true } },
    { method: "model/list", params: { cursor: "page-2", limit: 100, includeHidden: true } },
  ]);
});
it("rejects mismatched provider before asking for a model list", async () => {
  const rpc = connection([], "other");
  await expect(run(rpc)).rejects.toMatchObject({ code: "TEXT.CODEX_CATALOG_PROVIDER_MISMATCH", executionFact: "not_executed" });
  expect(rpc.calls).toHaveLength(1);
});
it.each([
  ["empty", done([]), "MODEL_UNAVAILABLE"],
  ["alias", done([{ ...entry, id: settings.model, model: "different", isDefault: true, upgrade: settings.model }]), "MODEL_UNAVAILABLE"],
  ["unsupported effort", done([{ ...entry, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "high" }]), "EFFORT_UNSUPPORTED"],
  ["empty efforts", done([{ ...entry, supportedReasoningEfforts: [] }]), "EFFORT_UNSUPPORTED"],
  ["image only", done([{ ...entry, inputModalities: ["image"] }]), "TEXT_UNSUPPORTED"],
  ["ambiguous", done([entry, { ...entry, id: "different-id" }]), "CATALOG_AMBIGUOUS"],
] as const)("rejects %s without fallback", async (_name, value, suffix) => {
  await expect(run(connection([value]))).rejects.toMatchObject({ code: `TEXT.CODEX_${suffix}`, executionFact: "not_executed" });
});
it.each([
  {}, { data: [entry] }, done([{ ...entry, inputModalities: undefined }]),
  done([{ ...entry, supportedReasoningEfforts: "high" }]),
  { data: [], nextCursor: "" }, done(Array.from({ length: 101 }, () => entry)),
])("rejects malformed/incomplete catalog without revealing raw input %#", async value => {
  await expect(run(connection([value]))).rejects.toMatchObject({ message: "TEXT.CODEX_PREFLIGHT_INVALID", executionFact: "not_executed" });
});
it("reads past a match to reject conflicts on later pages", async () => {
  await expect(run(connection([{ data: [entry], nextCursor: "second" }, done()]))).rejects.toThrow("TEXT.CODEX_CATALOG_AMBIGUOUS");
});
it("does not accept a partial catalog when a later page fails", async () => {
  await expect(run(connection([{ data: [entry], nextCursor: "second" }, new TextError("TEXT.CODEX_REQUEST_FAILED")]))).rejects.toMatchObject({ code: "TEXT.CODEX_REQUEST_FAILED", executionFact: "not_executed" });
});
it("bounds repeated cursors", async () => {
  const rpc = connection([{ data: [], nextCursor: "loop" }, { data: [], nextCursor: "loop" }]);
  await expect(run(rpc)).rejects.toThrow("TEXT.CODEX_CATALOG_CURSOR_LOOP");
  expect(rpc.calls).toHaveLength(3);
});
it("bounds the total pages even when every cursor is new", async () => {
  const rpc = connection(Array.from({ length: 20 }, (_, index) => ({ data: [], nextCursor: `${index}` })));
  await expect(run(rpc)).rejects.toThrow("TEXT.CODEX_CATALOG_LIMIT");
  expect(rpc.calls).toHaveLength(21);
});
it("accepts new effort names only when explicitly advertised", async () => {
  await run(connection([done([{ ...entry, supportedReasoningEfforts: [{ reasoningEffort: "future_effort" }] }])]), { ...settings, reasoningEffort: "future_effort" });
});
it("does not cache a positive response across operations", async () => {
  const rpc = connection([done(), done([])]);
  await run(rpc);
  await expect(run(rpc)).rejects.toThrow("TEXT.CODEX_MODEL_UNAVAILABLE");
});
it("does not send a read after cancellation or invalid settings", async () => {
  const rpc = connection();
  await expect(run(rpc, settings, AbortSignal.abort())).rejects.toMatchObject({ executionFact: "not_executed" });
  await expect(run(rpc, { ...settings, reasoningEffort: "" })).rejects.toThrow("TEXT.CODEX_PREFLIGHT_INVALID");
  expect(rpc.calls).toEqual([]);
});
it("sanitizes an unexpected read error", async () => {
  await expect(run(connection([Error("private-key=do-not-return")]))).rejects.toThrow(/^TEXT.CODEX_PREFLIGHT_INVALID$/);
});
it.each([{ custom: {} }, { custom: { enabled: true } }])("rejects active MCP configuration independently of internal request counts", async servers => {
  const rpc = connection([done()], "fixture", servers);
  await expect(run(rpc)).rejects.toThrow("TEXT.CODEX_RUNTIME_PROFILE");
  expect(rpc.calls).toHaveLength(1);
});
it("accepts explicitly disabled MCP entries in the text-only runtime profile", async () => {
  await run(connection([done()], "fixture", { custom: { enabled: false } }));
});
