import { OPENAI_NO_RETRY, executionProvider } from "./provider-id.js";

const disabled = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "apps",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "code_mode",
  "code_mode_host",
  "multi_agent",
  "multi_agent_v2",
  "hooks",
  "plugin_hooks",
  "plugins",
  "remote_plugin",
  "memories",
  "goals",
  "image_generation",
  "view_image",
  "tool_suggest",
  "skill_search",
  "skill_mcp_dependency_install",
];

function providerOverrides(provider: string): string[] {
  if (provider !== "openai") {
    return [
      "-c",
      `model_providers.${provider}.request_max_retries=0`,
      "-c",
      `model_providers.${provider}.stream_max_retries=0`,
    ];
  }
  // HTTP-only prevents WebSocket fallback; the preflight rejects inherited endpoint/auth overrides.
  return [
    "-c",
    `model_providers.${OPENAI_NO_RETRY}={name="OpenAI",wire_api="responses",` +
      "requires_openai_auth=true,supports_websockets=false," +
      "request_max_retries=0,stream_max_retries=0}",
  ];
}

export function connectionArguments(provider: string, servers: string[]): string[] {
  return [
    "app-server",
    "--stdio",
    "-c",
    `model_provider=${JSON.stringify(executionProvider(provider))}`,
    "-c",
    'web_search="disabled"',
    // Empty tables merge with inherited config, so disable every configured server explicitly.
    ...servers.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]),
    ...providerOverrides(provider),
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "tools.view_image=false",
    "-c",
    "analytics.enabled=false",
    "-c",
    'history.persistence="none"',
    // Older CLIs reject unknown --disable names; keep the equivalent config override.
    "-c",
    "features.sleep_tool=false",
    ...disabled.flatMap((feature) => ["--disable", feature]),
  ];
}
