import { expect, it } from "vitest";
import { codexConnection, CodexExecutionConfigSchema } from "./connection.js";
it("disables optional sleep without an unknown CLI switch and keeps the tool/secret boundary", () => {
  const c = codexConnection({ settings: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "medium" },
    executable: "/bin/codex", codexHome: "/private/profile", workRoot: "/private/work", runtimeProfileVersion: "test/1", timeoutMs: 240000,
    disabledMcpServers: ["node_repl", "computer-use"] },
    "/private/work/one", { PATH: "/bin", HTTPS_PROXY: "http://127.0.0.1:7897", R2_SECRET: "not-in-child", DATABASE_URL: "not-in-child" });
  expect(c.args).toContain("features.sleep_tool=false");
  expect(c.args).toContain("analytics.enabled=false");
  expect(c.args).toContain("model_providers.openai.request_max_retries=0");
  expect(c.args).toContain("model_providers.openai.stream_max_retries=0");
  expect(c.args).toContain('history.persistence="none"');
  expect(c.args).toContain('mcp_servers.node_repl.enabled=false');
  expect(c.args).toContain('mcp_servers.computer-use.enabled=false');
  expect(c.env.CODEX_HOME).toBe("/private/profile");
  expect(c.env.HOME).toBe("/private/work/one");
  expect(c.args).not.toContain("sleep_tool");
  for (const feature of ["shell_tool", "browser_use", "multi_agent", "plugins", "view_image"]) {
    const index = c.args.indexOf(feature); expect(index).toBeGreaterThan(0); expect(c.args[index - 1]).toBe("--disable");
  }
  expect(c.env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
  expect(c.env.R2_SECRET).toBeUndefined(); expect(c.env.DATABASE_URL).toBeUndefined();
});
it.each(["node.repl", 'node\"repl', "node repl", "", "a".repeat(201)])("rejects unsafe MCP override key %s before process launch", name => {
  expect(CodexExecutionConfigSchema.safeParse({ settings: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "medium" },
    executable: "/bin/codex", codexHome: "/private/profile", workRoot: "/private/work", runtimeProfileVersion: "test/1", timeoutMs: 240000,
    disabledMcpServers: [name] }).success).toBe(false);
});
