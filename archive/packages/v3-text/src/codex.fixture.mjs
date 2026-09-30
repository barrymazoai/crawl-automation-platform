// Child-process protocol fixture. It never executes Codex or calls a network endpoint.
import readline from "node:readline";
import { readFileSync } from "node:fs";
const scenario = process.argv[2];
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (method, params) => emit({ method, params });
const rl = readline.createInterface({ input: process.stdin });
let selectedEffort;
rl.on("line", line => {
  const message = JSON.parse(line);
  if (scenario === "malformed") { process.stdout.write("invalid JSON\n"); return; }
  if (scenario === "envelope") { emit({ id: message.id }); return; }
  if (scenario === "silence") return;
  if (scenario === "crash") { process.exit(3); }
  if (scenario === "server-request") { emit({ id: "server-1", method: "item/tool/call", params: {} }); return; }
  if (scenario === "oversized") { process.stdout.write("x".repeat(2100000)); return; }
  if (message.method === "initialize") { emit({ id: message.id, result: {} }); return; }
  if (message.method === "initialized") return;
  if (message.method === "config/read") {
    emit({ id: message.id, result: { config: { model_provider: scenario === "catalog-provider" ? "other" : "fixture" } } }); return;
  }
  if (message.method === "model/list") {
    if (scenario === "catalog-error") { emit({ id: message.id, error: { message: "private failure" } }); return; }
    emit({ id: message.id, result: { data: scenario === "catalog-missing" ? [] : [{ id: "picker-entry", model: "fixture-model",
      supportedReasoningEfforts: (scenario === "catalog-effort" ? ["low"] : ["low", "medium", "high"]).map(reasoningEffort => ({ reasoningEffort })),
      inputModalities: scenario === "catalog-image" ? ["image"] : ["text"] }], nextCursor: null } }); return;
  }
  if (message.method === "thread/start") {
    if (scenario.startsWith("catalog-")) throw Error("Must not start a thread after failed preflight");
    const p = message.params;
    selectedEffort = p.config?.model_reasoning_effort;
    if (typeof selectedEffort !== "string" || !selectedEffort) throw Error("Missing effort");
    if (p.allowProviderModelFallback !== false || p.sandbox !== "read-only" || p.ephemeral !== true || p.environments.length !== 0)
      throw Error("Unsafe thread settings");
    emit({ id: message.id, result: { thread: { id: "thread-1" }, model: scenario === "wrong-model" ? "other" : p.model,
      modelProvider: p.modelProvider, cwd: p.cwd, reasoningEffort: scenario === "wrong-effort" ? "different-effort" : selectedEffort, approvalPolicy: "never", sandbox: { type: "readOnly" } } }); return;
  }
  if (message.method === "turn/start") {
    if (scenario === "wrong-effort") throw Error("Must not start a turn after config mismatch");
    if (message.params.effort !== selectedEffort) throw Error("Effort was not passed through");
    if (scenario === "label-result" && (message.params.outputSchema?.properties?.codec?.const !== "label-extraction/1" ||
        !message.params.input?.[0]?.text?.includes("SAME ROW") || selectedEffort !== "medium")) throw Error("Label protocol was not passed through");
    const common = { threadId: "thread-1", turnId: "turn-1" };
    notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    if (scenario.startsWith("raw-")) {
      notify("rawResponseItem/completed", { ...common, item: { type: scenario.slice(4) } });
    }
    if (scenario === "internal-recovery" || scenario === "internal-hang") {
      for (let i = 0; i < 3; i++) notify("error", { ...common, error: { message: "Internal recovery" }, willRetry: true });
      if (scenario === "internal-hang") { emit({ id: message.id, result: { turn: { id: "turn-1" } } }); return; }
    }
    if (scenario === "rerouted") {
      notify("model/rerouted", { ...common, fromModel: "fixture-model", toModel: "other-model" });
      emit({ id: message.id, result: { turn: { id: "turn-1" } } }); return;
    }
    notify("rawResponseItem/completed", { ...common, item: { type: "reasoning" } });
    notify("rawResponseItem/completed", { ...common, item: { type: "message" } });
    if (scenario === "hang-turn") { emit({ id: message.id, result: { turn: { id: "turn-1" } } }); return; }
    if (scenario === "tool") notify("item/started", { ...common, item: { id: "tool-1", type: "commandExecution" } });
    if (scenario !== "missing") {
      notify("item/completed", { ...common, item: { id: "comment", type: "agentMessage", phase: "commentary", text: "not the final result" } });
      const answer = scenario === "label-result" ? readFileSync(process.argv[3], "utf8") : ' {"formula":null,"ingredients":null} ';
      notify("item/completed", { ...common, item: { id: "answer", type: "agentMessage", phase: "final_answer", text: answer } });
      if (scenario === "ambiguous") notify("item/completed", { ...common, item: { id: "answer-2", type: "agentMessage", text: "{}" } });
    }
    notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: scenario === "failed-turn" ? "failed" : "completed", error: null } });
    emit({ id: message.id, result: { turn: { id: scenario === "wrong-turn" ? "other-turn" : "turn-1" } } }); return;
  }
  emit({ id: message.id, error: { message: "unexpected method" } });
});
