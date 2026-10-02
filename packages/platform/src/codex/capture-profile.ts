import type { CodexExecutionConfig } from "./connection-settings.js";
import { connectionArguments } from "./connection-profile.js";

/** Keep the verified provider/no-retry settings, enabling only capture's shell and image tools. */
export function captureArguments(
  settings: CodexExecutionConfig,
  input: {
    cwd: string;
    schema: string;
    output: string;
    writableDirectories?: string[];
  },
): string[] {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--approve-for-me",
    "--cd",
    input.cwd,
    "--model",
    settings.settings.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(settings.settings.reasoningEffort)}`,
    "--output-schema",
    input.schema,
    "--output-last-message",
    input.output,
    "--json",
    "--color",
    "never",
    ...captureOverrides(settings),
    ...(input.writableDirectories ?? []).flatMap((directory) => ["--add-dir", directory]),
    "-",
  ];
}

function captureOverrides(settings: CodexExecutionConfig) {
  const inherited = connectionArguments(
    settings.settings.provider,
    settings.disabledMcpServers ?? [],
  ).slice(2);
  const enabled = new Set(["shell_tool", "unified_exec", "view_image"]);
  const filtered = inherited.filter(
    (entry, index) =>
      !(entry === "--disable" && enabled.has(inherited[index + 1] ?? "")) &&
      !(inherited[index - 1] === "--disable" && enabled.has(entry)) &&
      !(entry === "-c" && inherited[index + 1] === "tools.view_image=false") &&
      entry !== "tools.view_image=false",
  );
  return [
    ...filtered,
    "-c",
    "tools.view_image=true",
    "-c",
    "features.view_image=true",
    "-c",
    "features.shell_tool=true",
    "-c",
    "features.unified_exec=true",
    "-c",
    "sandbox_workspace_write.network_access=true",
  ];
}
