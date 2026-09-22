import { isAbsolute } from "node:path";
import { z } from "zod";
import { CodexModelSettingsSchema, VersionTagSchema } from "@crawl-automation/v3-contracts";
import { CodexRpc } from "./codex-rpc.js";

export const CodexExecutionConfigSchema = z.strictObject({
  settings: CodexModelSettingsSchema,
  executable: z.string().refine(isAbsolute),
  codexHome: z.string().refine(isAbsolute),
  workRoot: z.string().refine(isAbsolute),
  runtimeProfileVersion: VersionTagSchema,
  timeoutMs: z.number().int().min(1000).max(3600000),
  disabledMcpServers: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)).max(100).optional(),
});
export type CodexExecutionConfig = z.infer<typeof CodexExecutionConfigSchema>;
export type CodexConnectionOptions = ConstructorParameters<typeof CodexRpc>[0];
export type CodexConnectionFactory = (options: CodexConnectionOptions) => CodexRpc;

// This text-only profile does not grant command, browser, external app or environment access.
// No request/stream retry overrides: Codex manages its internal request lifecycle.
const disabled = ["shell_tool", "unified_exec", "shell_snapshot", "apps", "browser_use", "browser_use_external",
  "computer_use", "code_mode", "code_mode_host", "multi_agent", "multi_agent_v2", "hooks", "plugin_hooks",
  "plugins", "remote_plugin", "memories", "goals", "image_generation", "view_image",
  "tool_suggest", "skill_search", "skill_mcp_dependency_install"];
const inherited = ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];

export function codexConnection(config: CodexExecutionConfig, cwd: string, environment: NodeJS.ProcessEnv): CodexConnectionOptions {
  const env: NodeJS.ProcessEnv = {};
  for (const key of inherited) if (environment[key] !== undefined) env[key] = environment[key];
  // Never pass business DB/R2 secrets or inherit the user's working repository.
  env.HOME = cwd;
  env.CODEX_HOME = config.codexHome;
  return { executable: config.executable, cwd, env, args: ["app-server", "--stdio",
    "-c", `model_provider=${JSON.stringify(config.settings.provider)}`, "-c", 'web_search="disabled"',
    // Empty tables merge with user config, so explicitly disable every configured server.
    // The effective-config preflight rejects an omitted/new enabled server before any turn.
    ...(config.disabledMcpServers ?? []).flatMap(name => ["-c", `mcp_servers.${name}.enabled=false`]),
    "-c", "project_doc_max_bytes=0", "-c", "tools.view_image=false",
    // History persistence controls history.jsonl. thread/start ephemeral=true controls
    // the task transcript; neither setting caps the diagnostic SQLite database.
    "-c", "analytics.enabled=false", "-c", 'history.persistence="none"',
    // CLI 0.147 rejects unknown --disable names. Keep this future feature explicitly
    // false through the equivalent config override; do not relax the runtime profile.
    "-c", "features.sleep_tool=false",
    ...disabled.flatMap(feature => ["--disable", feature])] };
}
