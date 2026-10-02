import { expect, it } from "vitest";
import { captureArguments } from "./capture-profile.js";
import { CodexExecutionConfigSchema } from "./connection-settings.js";

it("enables capture tools while retaining explicit model, no-retry provider and sandbox", () => {
  const config = CodexExecutionConfigSchema.parse({
    executable: "/tmp/codex",
    codexHome: "/tmp/private-auth",
    workRoot: "/tmp/capture",
    runtimeProfileVersion: "capture/1",
    timeoutMs: 60000,
    settings: { model: "gpt-5.6-luna", provider: "openai", reasoningEffort: "medium" },
    disabledMcpServers: ["node_repl"],
  });
  const args = captureArguments(config, {
    cwd: "/tmp/capture/one",
    schema: "/tmp/schema.json",
    output: "/tmp/result.json",
  });
  expect(args[0]).toBe("exec");
  expect(args).toContain("--approve-for-me");
  expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(args).toContain("features.shell_tool=true");
  expect(args).toContain("tools.view_image=true");
  expect(args).toContain("features.code_mode=true");
  expect(args).toContain("features.code_mode_host=true");
  expect(args).toContain("mcp_servers.node_repl.enabled=false");
  expect(args.join(" ")).toContain("request_max_retries=0");
  expect(args.join(" ")).not.toContain("--disable shell_tool");
  expect(args.join(" ")).not.toContain("--disable view_image");
  expect(args.join(" ")).not.toContain("--disable code_mode");
});
