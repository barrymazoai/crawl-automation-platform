import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  CodexExecutionConfigSchema,
  EgoSettingsSchema,
  type CodexExecutionConfig,
  type EgoSettings,
  type RetainedPublication,
} from "@crawl-automation/platform";
import { CodexTextConfigSchema, type CodexTextConfig } from "../text/model/codex-text-model.js";
import { brandResearchErrors } from "./errors.js";

/** Composition-root dependencies; neither API credentials nor application services enter prompts. */
/** What the three tool-free text turns need: only the worker's text model. */
export type BrandTextDeps = Pick<BrandResearchDeps, "text" | "environment">;

export interface BrandResearchDeps {
  text: CodexTextConfig;
  capture: CodexExecutionConfig;
  ego: EgoSettings;
  publication: Pick<RetainedPublication, "publish">;
  workRoot: string;
  skillPaths: { ego: string; research: string[] };
  environment: NodeJS.ProcessEnv;
}

const SettingsSchema = z.object({
  text: CodexTextConfigSchema,
  capture: CodexExecutionConfigSchema,
  ego: EgoSettingsSchema,
  workRoot: z.string().refine(isAbsolute),
  skillPaths: z.object({
    ego: z.string().refine(isAbsolute),
    research: z.array(z.string().refine(isAbsolute)),
  }),
});

export function checkedTextDependencies(deps: BrandTextDeps): BrandTextDeps {
  const parsed = CodexTextConfigSchema.safeParse(deps.text);
  if (!parsed.success) {
    throw brandResearchErrors.create("BRAND_RESEARCH.SETTINGS_INVALID", { cause: parsed.error });
  }
  return { ...deps, text: parsed.data };
}

export function checkedDependencies(deps: BrandResearchDeps): BrandResearchDeps {
  const parsed = SettingsSchema.safeParse(deps);
  if (!parsed.success) {
    throw brandResearchErrors.create("BRAND_RESEARCH.SETTINGS_INVALID", { cause: parsed.error });
  }
  // Both tool-enabled tasks and tool-free turns use the worker's selected text model, including effort.
  return {
    ...deps,
    ...parsed.data,
    capture: { ...parsed.data.capture, settings: { ...parsed.data.text.settings } },
  };
}
