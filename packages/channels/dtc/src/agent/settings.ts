import { isAbsolute } from "node:path";
import { z } from "zod";
import { CodexExecutionConfigSchema } from "@crawl-automation/platform";

export const DtcAgentSettingsSchema = z.strictObject({
  codex: CodexExecutionConfigSchema,
  egoSkillPath: z.string().refine(isAbsolute),
  modelResourceId: z.string().min(1),
});
export type DtcAgentSettings = z.infer<typeof DtcAgentSettingsSchema>;
