import { expect, it } from "vitest";
import { codexConnection } from "./connection.js";
import { CodexExecutionConfigSchema } from "./connection-settings.js";
it("disables sleep without an unknown CLI switch and keeps the tool/secret boundary", () => {
  const connection = codexConnection(
    {
      settings: { provider: "openai", model: "fixture-model", reasoningEffort: "medium" },
      executable: "/bin/codex",
      codexHome: "/private/profile",
      workRoot: "/private/work",
      runtimeProfileVersion: "test/1",
      timeoutMs: 240000,
      disabledMcpServers: ["node_repl", "computer-use"],
    },
    "/private/work/one",
    {
      PATH: "/bin",
      HTTPS_PROXY: "http://127.0.0.1:7897",
      R2_SECRET: "not-in-child",
      DATABASE_URL: "not-in-child",
    },
  );
  expect(connection.args).toContain("features.sleep_tool=false");
  expect(connection.args).toContain("analytics.enabled=false");
  expect(connection.args).toContain('model_provider="crawler_openai_no_retry"');
  expect(connection.args).toContain(
    'model_providers.crawler_openai_no_retry={name="OpenAI",wire_api="responses",' +
      "requires_openai_auth=true,supports_websockets=false," +
      "request_max_retries=0,stream_max_retries=0}",
  );
  expect(connection.args.some((argument) => argument.startsWith("model_providers.openai."))).toBe(
    false,
  );
  expect(connection.args).toContain('history.persistence="none"');
  expect(connection.args).toContain("mcp_servers.node_repl.enabled=false");
  expect(connection.args).toContain("mcp_servers.computer-use.enabled=false");
  expect(connection.env.CODEX_HOME).toBe("/private/profile");
  expect(connection.env.HOME).toBe("/private/work/one");
  expect(connection.args).not.toContain("sleep_tool");
  for (const feature of ["shell_tool", "browser_use", "multi_agent", "plugins", "view_image"]) {
    const index = connection.args.indexOf(feature);
    expect(index).toBeGreaterThan(0);
    expect(connection.args[index - 1]).toBe("--disable");
  }
  expect(connection.env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
  expect(connection.env.R2_SECRET).toBeUndefined();
  expect(connection.env.DATABASE_URL).toBeUndefined();
});
it.each(["node.repl", 'node"repl', "node repl", "", "a".repeat(201)])(
  "rejects unsafe MCP override key %s before process launch",
  (name) => {
    expect(
      CodexExecutionConfigSchema.safeParse({
        settings: { provider: "openai", model: "fixture-model", reasoningEffort: "medium" },
        executable: "/bin/codex",
        codexHome: "/private/profile",
        workRoot: "/private/work",
        runtimeProfileVersion: "test/1",
        timeoutMs: 240000,
        disabledMcpServers: [name],
      }).success,
    ).toBe(false);
  },
);
