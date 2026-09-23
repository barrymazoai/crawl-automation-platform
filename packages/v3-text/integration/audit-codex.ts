// Explicit local audit: real CLI, synthetic loopback Responses endpoint, no real account/model.
import { createServer } from "node:http";
import { hostname } from "node:os";
if (!/^(barrydeMac-mini|servers-Mac-mini)(?:\.|$)/.test(hostname())) throw Error("Run provider audit on Mac mini");
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexRpc } from "../src/codex-rpc.js";
import { CodexTextProvider } from "../src/codex-provider.js";
const root = await mkdtemp("/private/tmp/crawlv3-codex-audit-");
const mode = process.env.V3_CODEX_AUDIT_MODE ?? "http-500";
if (!["http-500", "success", "stream-drop", "preflight-missing", "tool-skills", "tool-user-input", "tool-shell"].includes(mode))
    throw Error("Unsupported local scenario");
const requests: {
    path: string;
    toolNames: unknown[];
    model: unknown;
    reasoning: unknown;
}[] = [];
const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request)
        chunks.push(Buffer.from(chunk));
    let body: Record<string, unknown> = {};
    try {
        body = JSON.parse(Buffer.concat(chunks).toString());
    }
    catch { }
    requests.push({ path: request.url ?? "", toolNames: Array.isArray(body.tools) ? body.tools.map((t: {
            name?: string;
            type?: string;
        }) => t.name ?? t.type) : [], model: body.model, reasoning: body.reasoning });
    if (mode === "http-500") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "synthetic failure", type: "server_error" } }));
        return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit("response.created", { response: { id: "resp_audit", status: "in_progress", output: [] } });
    if (mode === "stream-drop") {
        response.end();
        return;
    }
    if (mode.startsWith("tool-") && requests.length <= 3) {
        // Adversarial synthetic response, not a real model or permission to execute a tool.
        const names: Record<string, string> = { "tool-skills": "skills", "tool-user-input": "request_user_input", "tool-shell": "shell" };
        const item = { id: "fc_audit", type: "function_call", call_id: "call_audit", name: names[mode], arguments: "{}", status: "completed" };
        emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
        emit("response.output_item.done", { output_index: 0, item });
        emit("response.completed", { response: { id: "resp_audit", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
        response.end();
        return;
    }
    const item = { id: "msg_audit", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{}', annotations: [] }] };
    emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
    emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: '{}' });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", { response: { id: "resp_audit", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    response.end();
});
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
if (!address || typeof address === "string")
    throw Error();
const off = ["shell_tool", "unified_exec", "shell_snapshot", "apps", "browser_use", "browser_use_external", "computer_use", "code_mode", "code_mode_host", "multi_agent", "multi_agent_v2", "hooks", "plugin_hooks", "plugins", "remote_plugin", "memories", "goals", "image_generation", "view_image", "tool_suggest", "skill_search", "skill_mcp_dependency_install"];
const args = ["app-server", "--stdio", "-c", 'model_provider="audit"', "-c", 'model_providers.audit.name="Local audit"', "-c", `model_providers.audit.base_url="http://127.0.0.1:${address.port}/v1"`, "-c", 'model_providers.audit.wire_api="responses"', "-c", "model_providers.audit.request_max_retries=0", "-c", "model_providers.audit.stream_max_retries=0", "-c", "model_providers.audit.supports_websockets=false", "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0", ...off.flatMap(k => ["--disable", k])];
const makeRpc = () => new CodexRpc({ executable: process.env.V3_CODEX_AUDIT_BIN ?? "/Users/songtianjian/.nvm/versions/node/v22.17.0/bin/codex", args, cwd: root,
    env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root, TMPDIR: root } });
let provider: CodexTextProvider | undefined;
try {
    // Deliberately configure the old defaults. Production command-line overrides
    // must force zero retries, even when a retained private home asks for more.
    await writeFile(join(root, "config.toml"), `model_provider="audit"\n[model_providers.audit]\nname="Local audit"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequest_max_retries=4\nstream_max_retries=5\nsupports_websockets=false\n`, { mode: 0o600 });
    // Pick an advertised name ONLY for the synthetic loopback test; never configure a user's Worker.
    let auditModel = "crawler-v3-deliberately-unavailable-model";
    if (mode !== "preflight-missing") {
        const discovery = makeRpc();
        try {
            const signal = AbortSignal.timeout(20000);
            await discovery.initialize(signal);
            const catalog = await discovery.request("model/list", { limit: 100, includeHidden: true }, signal) as {
                data: { model: string; inputModalities: string[]; supportedReasoningEfforts: { reasoningEffort: string }[] }[];
            };
            const match = catalog.data.find(m => m.inputModalities.includes("text") && m.supportedReasoningEfforts.some(e => e.reasoningEffort === "high"));
            if (!match) throw Error("No advertised model for isolated protocol audit");
            auditModel = match.model;
        } finally { await discovery.close(); }
    }
    provider = await CodexTextProvider.open({ settings: { model: auditModel, provider: "audit", reasoningEffort: "high" },
        executable: process.env.V3_CODEX_AUDIT_BIN ?? "/Users/songtianjian/.nvm/versions/node/v22.17.0/bin/codex",
        codexHome: root, workRoot: join(root, "work"), runtimeProfileVersion: "loopback-audit/1", timeoutMs: 20000 }, { PATH: process.env.PATH });
    let outcome: string;
    try {
        outcome = await provider.interpret({ operationId: "audit-operation", prompt: "Reply with an empty JSON object.",
            outputSchema: { type: "object", properties: {}, additionalProperties: false } }, AbortSignal.timeout(20000));
    }
    catch (e) {
        outcome = e instanceof Error ? e.message : "unknown";
    }
    const expectedOutcome = mode === "preflight-missing" ? "TEXT.CODEX_MODEL_UNAVAILABLE" : mode === "success" || mode.startsWith("tool-") ? "{}" : "TEXT.CODEX_TURN_FAILED";
    const passed = outcome === expectedOutcome && (mode === "preflight-missing" ? requests.length === 0 :
        requests.length === (mode.startsWith("tool-") ? 4 : 1) && requests.every(r => r.path === "/v1/responses" && r.model === auditModel &&
        (r.reasoning as { effort?: string } | undefined)?.effort === "high"));
    console.log(JSON.stringify({ root, mode, auditModel, outcome, passed, requestCount: requests.length, requests: requests.slice(0, 10), realModelRequests: 0 }, null, 2));
    if (!passed) process.exitCode = 1;
}
finally {
    await provider?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
}
