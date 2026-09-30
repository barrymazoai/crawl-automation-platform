#!/usr/bin/env node
// Test executable only. It is not included in the business build and never contacts a model.
import readline from "node:readline";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (method, params) => emit({ method, params });
const rl = readline.createInterface({ input: process.stdin });
let settings;
rl.on("line", async line => {
  const { method, id, params } = JSON.parse(line);
  if (method === "initialize") { emit({ id, result: {} }); return; }
  if (method === "initialized") return;
  if (method === "config/read") { emit({ id, result: { config: { model_provider: "fixture", mcp_servers: {} } } }); return; }
  if (method === "model/list") { emit({ id, result: { data: [{ id: "fixture", model: "fixture-model", inputModalities: ["text", "image"], supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null } }); return; }
  if (method === "thread/start") {
    settings = params;
    emit({ id, result: { thread: { id: "thread-test" }, model: params.model, modelProvider: params.modelProvider,
      cwd: params.cwd, reasoningEffort: params.config.model_reasoning_effort, approvalPolicy: "never", sandbox: { type: "readOnly" } } }); return;
  }
  if (method === "turn/start") {
    const common = { threadId: "thread-test", turnId: "turn-test" };
    const image = params.input.find(i => i.type === "localImage");
    if (!image || image.detail !== "original" || !(await readFile(image.path)).length) throw Error("Missing original image");
    const itemText = "vision";
    const mode = (await readFile(join(process.env.CODEX_HOME, "scenario"), "utf8")).trim();
    await appendFile(join(process.env.CODEX_HOME, "executions.jsonl"), JSON.stringify({ pid: process.pid, cwd: settings.cwd, text: itemText }) + "\n");
    emit({ id, result: { turn: { id: "turn-test" } } });
    notify("turn/started", { threadId: common.threadId, turn: { id: common.turnId } });
    // Multiple recoverable internal events are still one business execution.
    for (let i = 0; i < 3; i++) notify("error", { ...common, error: { message: "Synthetic internal recovery" }, willRetry: true });
    if (mode === "fail") { notify("turn/completed", { threadId: common.threadId, turn: { id: common.turnId, status: "failed" } }); return; }
    const field = text => ({ text, evidence: text });
    const raw = JSON.stringify({ schemaVersion: 1, formula: { servingSize: field("1 capsule"), servingsPerContainer: null,
      columns: [{ heading: "Per serving", nutrients: [{ name: field("Blend"), amount: field("10 mg"), dailyValue: null }] }] },
      ingredients: [{ name: "Ginger root", evidence: "Ginger root", role: "blend_component", parentBlend: "Blend" }],
      formulaComplete: true, ingredientsComplete: true, issues: [] });
    setTimeout(() => {
      notify("item/completed", { ...common, item: { id: "answer", type: "agentMessage", phase: "final_answer", text: raw } });
      notify("turn/completed", { threadId: common.threadId, turn: { id: common.turnId, status: "completed", error: null } });
    }, itemText.startsWith("SLOW") ? 200 : 0);
    return;
  }
  emit({ id, error: { message: "Unexpected fixture request" } });
});
