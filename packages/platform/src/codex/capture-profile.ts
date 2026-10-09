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
    webSearch?: "live" | "disabled";
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
    ...captureOverrides(settings, input.webSearch ?? "disabled"),
    ...(input.writableDirectories ?? []).flatMap((directory) => ["--add-dir", directory]),
    "-",
  ];
}

const ENABLED_TOOLS = new Set([
  "shell_tool",
  "unified_exec",
  "view_image",
  "code_mode",
  "code_mode_host",
]);
/** Inherited `-c` values capture replaces with its own. */
const REPLACED_VALUES = new Set(["tools.view_image=false", 'web_search="disabled"']);

/** Drops an inherited `--disable <tool>` for a capture tool and the `-c` values capture sets itself. */
function inheritedKept(entry: string, next: string | undefined, previous: string | undefined) {
  if (entry === "--disable" && ENABLED_TOOLS.has(next ?? "")) {
    return false;
  }
  if (previous === "--disable" && ENABLED_TOOLS.has(entry)) {
    return false;
  }
  if (entry === "-c" && REPLACED_VALUES.has(next ?? "")) {
    return false;
  }
  return !REPLACED_VALUES.has(entry);
}

function captureOverrides(settings: CodexExecutionConfig, webSearch: "live" | "disabled") {
  const inherited = connectionArguments(
    settings.settings.provider,
    settings.disabledMcpServers ?? [],
  ).slice(2);
  return [
    ...inherited.filter((entry, index) =>
      inheritedKept(entry, inherited[index + 1], inherited[index - 1]),
    ),
    ...[
      "tools.view_image=true",
      "features.view_image=true",
      "features.shell_tool=true",
      "features.unified_exec=true",
      "features.code_mode=true",
      "features.code_mode_host=true",
      "sandbox_workspace_write.network_access=true",
      `web_search=${JSON.stringify(webSearch)}`,
    ].flatMap((value) => ["-c", value]),
  ];
}
