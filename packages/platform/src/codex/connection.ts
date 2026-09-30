import type { CodexConnectionOptions, CodexExecutionConfig } from "./connection-settings.js";
import { connectionArguments } from "./connection-profile.js";

const inherited = [
  "PATH",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

/** Never inherit business credentials or the user's working repository. */
export function codexConnection(
  config: CodexExecutionConfig,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): CodexConnectionOptions {
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const key of inherited) {
    if (environment[key] !== undefined) {
      childEnvironment[key] = environment[key];
    }
  }
  childEnvironment.HOME = cwd;
  childEnvironment.CODEX_HOME = config.codexHome;
  return {
    executable: config.executable,
    cwd,
    env: childEnvironment,
    args: connectionArguments(config.settings.provider, config.disabledMcpServers ?? []),
  };
}
