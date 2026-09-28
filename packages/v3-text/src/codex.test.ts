import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";
import { CodexRpc } from "./codex-rpc.js";
import { runCodexTextTurn } from "./codex-turn.js";
const fixture = fileURLToPath(new URL("./codex.fixture.mjs", import.meta.url));
const rpc = (scenario: string) => new CodexRpc({ executable: process.execPath, args: [fixture, scenario], cwd: process.cwd(), env: {} });
const input = { model: "fixture-model", provider: "fixture", reasoningEffort: "high", cwd: process.cwd(), prompt: "untrusted evidence", outputSchema: { type: "object" } };
it("accepts matching early notifications before start acknowledgement and preserves the exact final response", async () => {
    expect(await runCodexTextTurn(rpc("success"), input, AbortSignal.timeout(3000))).toBe(' {"formula":null,"ingredients":null} ');
});
it.each(["wrong-model", "wrong-turn", "missing", "failed-turn"])("fails closed without a replacement thread or turn: %s", async (scenario) => {
    await expect(runCodexTextTurn(rpc(scenario), input, AbortSignal.timeout(3000))).rejects.toThrow();
});
it("uses the last final message at turn completion rather than treating internal answers as duplicate executions", async () => {
    expect(await runCodexTextTurn(rpc("ambiguous"), input, AbortSignal.timeout(3000))).toBe("{}");
});
it.each(["malformed", "envelope", "crash", "server-request", "oversized"])("rejects a broken owned child connection: %s", async (scenario) => {
    const connection = rpc(scenario);
    try {
        await expect(connection.initialize(AbortSignal.timeout(2000))).rejects.toThrow();
    }
    finally {
        await connection.close();
    }
});
it("times out one request without reconnecting", async () => {
    const connection = rpc("silence");
    try {
        await expect(connection.request("initialize", {}, new AbortController().signal, 40)).rejects.toThrow("TEXT.CODEX_TIMEOUT");
        await expect(connection.initialize(new AbortController().signal)).rejects.toThrow("TEXT.CODEX_TIMEOUT");
    }
    finally {
        await connection.close();
    }
});
it("cancels after turn/start acknowledgement, not only while awaiting an RPC reply", async () => {
    await expect(runCodexTextTurn(rpc("hang-turn"), input, new AbortController().signal, 150)).rejects.toThrow();
});
it("separate child sessions process concurrently without shared active-thread state", async () => {
    const values = await Promise.all(Array.from({ length: 3 }, () => runCodexTextTurn(rpc("success"), input, AbortSignal.timeout(3000))));
    expect(values).toHaveLength(3);
    expect(new Set(values).size).toBe(1);
});
it("rejects an effective reasoning effort mismatch before starting a model turn", async () => {
    await expect(runCodexTextTurn(rpc("wrong-effort"), input, AbortSignal.timeout(3000))).rejects.toThrow("TEXT.CODEX_CONFIG_MISMATCH");
});
it.each(["low", "medium", "high"])("passes the selected effort through both thread config and turn params: %s", async reasoningEffort => {
    expect(await runCodexTextTurn(rpc("success"), { ...input, reasoningEffort }, AbortSignal.timeout(3000))).toContain('"formula"');
});
it("rejects blank effort instead of inheriting a user's global default", async () => {
    await expect(runCodexTextTurn(rpc("success"), { ...input, reasoningEffort: "" }, AbortSignal.timeout(3000))).rejects.toThrow();
});
it.each([
    ["catalog-provider", "CATALOG_PROVIDER_MISMATCH"], ["catalog-missing", "MODEL_UNAVAILABLE"],
    ["catalog-effort", "EFFORT_UNSUPPORTED"], ["catalog-image", "TEXT_UNSUPPORTED"], ["catalog-error", "REQUEST_FAILED"],
])("stops before thread/start when the owned runtime fails model preflight: %s", async (scenario, suffix) => {
    await expect(runCodexTextTurn(rpc(scenario), input, AbortSignal.timeout(3000))).rejects.toMatchObject({ code: `TEXT.CODEX_${suffix}`, executionFact: "not_executed" });
});
it.each(["function_call", "custom_tool_call", "local_shell_call", "web_search_call", "tool_search_call", "unknown_future_item"])("does not police internal raw response items: %s", async type => {
    expect(await runCodexTextTurn(rpc(`raw-${type}`), input, AbortSignal.timeout(3000))).toContain('"formula"');
});
it.each(["tool"])("waits for the final result through non-error internal events: %s", async scenario => {
    expect(await runCodexTextTurn(rpc(scenario), input, AbortSignal.timeout(3000))).toContain('"formula"');
});
it("still enforces the overall execution deadline during internal recovery", async () => {
    await expect(runCodexTextTurn(rpc("internal-hang"), input, new AbortController().signal, 150)).rejects.toThrow();
});
it("rejects a reported model reroute instead of accepting another model's answer", async () => {
    await expect(runCodexTextTurn(rpc("rerouted"), input, AbortSignal.timeout(3000))).rejects.toThrow("TEXT.CODEX_CONFIG_MISMATCH");
});

it.each(["internal-recovery","internal-hang"])("the first error closes the child without accepting subsequent output: %s",async scenario=>{
 await expect(runCodexTextTurn(rpc(scenario),input,AbortSignal.timeout(3000))).rejects.toMatchObject({code:"TEXT.CODEX_TURN_FAILED",detail:"Internal recovery"});
});
