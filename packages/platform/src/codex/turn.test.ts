import { dirname } from "node:path";
import { it, expect } from "vitest";
import { CodexRpc } from "./codex-rpc.js";
import { runCodexTurn } from "./codex-turn.js";
import { fakeCodexServerPath } from "./testing/fixture-path.js";
const rpc = (scenario: string) =>
  new CodexRpc({
    executable: process.execPath,
    args: ["--import", "tsx", fakeCodexServerPath, scenario],
    cwd: dirname(fakeCodexServerPath),
    env: {},
  });
const input = {
  model: "fixture-model",
  provider: "fixture",
  reasoningEffort: "high",
  cwd: process.cwd(),
  prompt: "untrusted evidence",
  outputSchema: { type: "object" },
};
it("accepts matching early notifications and preserves the exact final response", async () => {
  expect(await runCodexTurn(rpc("success"), input, { signal: AbortSignal.timeout(3000) })).toBe(
    ' {"formula":null,"ingredients":null} ',
  );
});
it.each(["wrong-model", "wrong-turn", "missing", "failed-turn"])(
  "fails closed without a replacement thread or turn: %s",
  async (scenario) => {
    await expect(
      runCodexTurn(rpc(scenario), input, { signal: AbortSignal.timeout(3000) }),
    ).rejects.toThrow();
  },
);
it("uses the last final message at turn completion, including intermediate answers", async () => {
  expect(await runCodexTurn(rpc("ambiguous"), input, { signal: AbortSignal.timeout(3000) })).toBe(
    "{}",
  );
});
it.each(["malformed", "envelope", "crash", "server-request", "oversized"])(
  "rejects a broken owned child connection: %s",
  async (scenario) => {
    const connection = rpc(scenario);
    try {
      await expect(connection.initialize(AbortSignal.timeout(2000))).rejects.toThrow();
    } finally {
      await connection.close();
    }
  },
);
it("times out one request without reconnecting", async () => {
  const connection = rpc("silence");
  try {
    await expect(
      connection.request("initialize", {}, { signal: new AbortController().signal, timeoutMs: 40 }),
    ).rejects.toThrow(expect.objectContaining({ code: "TEXT.CODEX_TIMEOUT" }));
    await expect(connection.initialize(new AbortController().signal)).rejects.toThrow(
      expect.objectContaining({ code: "TEXT.CODEX_TIMEOUT" }),
    );
  } finally {
    await connection.close();
  }
});
it("cancels after turn/start acknowledgement, not only while awaiting an RPC reply", async () => {
  await expect(
    runCodexTurn(rpc("hang-turn"), input, { signal: new AbortController().signal, timeoutMs: 150 }),
  ).rejects.toThrow();
});
it("separate child sessions process concurrently without shared active-thread state", async () => {
  const values = await Promise.all(
    Array.from({ length: 3 }, () =>
      runCodexTurn(rpc("success"), input, { signal: AbortSignal.timeout(3000) }),
    ),
  );
  expect(values).toHaveLength(3);
  expect(new Set(values).size).toBe(1);
});
it("rejects an effective reasoning effort mismatch before starting a model turn", async () => {
  await expect(
    runCodexTurn(rpc("wrong-effort"), input, { signal: AbortSignal.timeout(3000) }),
  ).rejects.toThrow(expect.objectContaining({ code: "TEXT.CODEX_CONFIG_MISMATCH" }));
});
it.each(["low", "medium", "high"])(
  "passes the selected effort through both thread config and turn params: %s",
  async (reasoningEffort) => {
    expect(
      await runCodexTurn(
        rpc("success"),
        { ...input, reasoningEffort },
        { signal: AbortSignal.timeout(3000) },
      ),
    ).toContain('"formula"');
  },
);
it("rejects blank effort instead of inheriting a user's global default", async () => {
  await expect(
    runCodexTurn(
      rpc("success"),
      { ...input, reasoningEffort: "" },
      { signal: AbortSignal.timeout(3000) },
    ),
  ).rejects.toThrow();
});
it.each([
  ["catalog-provider", "CATALOG_PROVIDER_MISMATCH"],
  ["catalog-missing", "MODEL_UNAVAILABLE"],
  ["catalog-effort", "EFFORT_UNSUPPORTED"],
  ["catalog-image", "TEXT_UNSUPPORTED"],
  ["catalog-error", "REQUEST_FAILED"],
])(
  "stops before thread/start when the owned runtime fails model preflight: %s",
  async (scenario, suffix) => {
    await expect(
      runCodexTurn(rpc(scenario), input, { signal: AbortSignal.timeout(3000) }),
    ).rejects.toMatchObject({ code: `TEXT.CODEX_${suffix}`, executionFact: "not_executed" });
  },
);
it.each([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search_call",
  "tool_search_call",
  "unknown_future_item",
])("does not police internal raw response items: %s", async (type) => {
  expect(
    await runCodexTurn(rpc(`raw-${type}`), input, { signal: AbortSignal.timeout(3000) }),
  ).toContain('"formula"');
});
it.each(["tool"])(
  "waits for the final result through non-error internal events: %s",
  async (scenario) => {
    expect(
      await runCodexTurn(rpc(scenario), input, { signal: AbortSignal.timeout(3000) }),
    ).toContain('"formula"');
  },
);
it("still enforces the overall execution deadline during internal recovery", async () => {
  await expect(
    runCodexTurn(rpc("internal-hang"), input, {
      signal: new AbortController().signal,
      timeoutMs: 150,
    }),
  ).rejects.toThrow();
});
it("rejects a reported model reroute instead of accepting another model's answer", async () => {
  await expect(
    runCodexTurn(rpc("rerouted"), input, { signal: AbortSignal.timeout(3000) }),
  ).rejects.toThrow(expect.objectContaining({ code: "TEXT.CODEX_CONFIG_MISMATCH" }));
});

it.each(["internal-recovery", "internal-hang"])(
  "the first error closes the child without accepting subsequent output: %s",
  async (scenario) => {
    await expect(
      runCodexTurn(rpc(scenario), input, { signal: AbortSignal.timeout(3000) }),
    ).rejects.toMatchObject({ code: "TEXT.CODEX_TURN_FAILED", detail: "Internal recovery" });
  },
);
