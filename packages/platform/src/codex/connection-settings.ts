import { isAbsolute } from "node:path";
import { z } from "zod";
import { CodexModelSettingsSchema, VersionTagSchema } from "@crawl-automation/v3-contracts";
import type { CodexRpc } from "./codex-rpc.js";

export const CodexExecutionConfigSchema = z.strictObject({
  settings: CodexModelSettingsSchema,
  executable: z.string().refine(isAbsolute),
  codexHome: z.string().refine(isAbsolute),
  workRoot: z.string().refine(isAbsolute),
  runtimeProfileVersion: VersionTagSchema,
  timeoutMs: z.number().int().min(1000).max(3600000),
  disabledMcpServers: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/))
    .max(100)
    .optional(),
});
export type CodexExecutionConfig = z.infer<typeof CodexExecutionConfigSchema>;
export type CodexConnectionOptions = ConstructorParameters<typeof CodexRpc>[0];
export type CodexConnectionFactory = (options: CodexConnectionOptions) => CodexRpc;
