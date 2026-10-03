import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  CodexExecutionConfigSchema,
  type EgoSettings,
  type RetainedPublication,
} from "@crawl-automation/platform";

export const DtcAgentSettingsSchema = z.strictObject({
  codex: CodexExecutionConfigSchema,
  egoSkillPath: z.string().refine(isAbsolute),
  modelResourceId: z.string().min(1),
});
export type DtcAgentSettings = z.infer<typeof DtcAgentSettingsSchema>;

export interface AgentCaptureDependencies {
  settings: DtcAgentSettings;
  ego: EgoSettings;
  publication: RetainedPublication;
  skillRoot: string;
  environment: NodeJS.ProcessEnv;
}
