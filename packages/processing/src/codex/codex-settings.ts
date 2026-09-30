import { lstat, mkdir, realpath } from "node:fs/promises";
import { platformErrors } from "@crawl-automation/platform";
import { CodexExecutionConfigSchema, type CodexExecutionConfig } from "@crawl-automation/platform";

export { CodexExecutionConfigSchema as CodexClientSettingsSchema };
export type CodexClientSettings = CodexExecutionConfig;

/**
 * The settings with their directories checked: private to this user, real directories (no links), and resolved to
 * their real paths. Throws when any check fails.
 */
export async function privateSettings(raw: unknown): Promise<CodexClientSettings> {
  const settings = CodexExecutionConfigSchema.parse(raw);
  await mkdir(settings.workRoot, { recursive: true, mode: 0o700 });
  for (const directory of [settings.workRoot, settings.codexHome]) {
    await assertPrivateDirectory(directory);
  }
  return {
    ...settings,
    settings: Object.freeze({ ...settings.settings }),
    workRoot: await realpath(settings.workRoot),
    codexHome: await realpath(settings.codexHome),
  };
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  const shared = process.platform !== "win32" && (stat.mode & 0o077) !== 0;
  if (!stat.isDirectory() || stat.isSymbolicLink() || shared) {
    throw platformErrors.create("CONFIG.UNSAFE_DIRECTORY");
  }
}
