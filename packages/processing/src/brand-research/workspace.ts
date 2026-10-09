import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { sha256, type EgoAgentPage } from "@crawl-automation/platform";
import { evidenceModule } from "./evidence-module.js";
import type { BrandSubject } from "./inputs.js";
import type { BrandResearchDeps } from "./settings.js";

export interface ResearchWorkspace {
  cwd: string;
  prefix: string;
  skillPaths: string[];
}

export async function prepareWorkspace(
  deps: BrandResearchDeps,
  input: { task: string; subject: BrandSubject },
): Promise<ResearchWorkspace> {
  const runKey = sha256(Buffer.from(input.subject.runId));
  const root = join(deps.workRoot, "brand-research", runKey);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const cwd = await realpath(await mkdtemp(join(root, `${input.task}-`)));
  await mkdir(join(cwd, "pages"), { mode: 0o700 });
  const skillPaths = [
    ...new Set([deps.skillPaths.ego, ...deps.skillPaths.research].map((path) => resolve(path))),
  ];
  const skills = await Promise.all(
    skillPaths.map(async (path) => ({ path, sha256: sha256(await readFile(path)) })),
  );
  await writeFile(join(cwd, "skills.json"), JSON.stringify(skills), { flag: "wx", mode: 0o600 });
  await writeFile(join(cwd, "request.json"), JSON.stringify(input), { flag: "wx", mode: 0o600 });
  return { cwd, prefix: `v3/brand-research/${runKey}/${basename(cwd)}`, skillPaths };
}

export async function preparePage(workspace: ResearchWorkspace, page: EgoAgentPage) {
  await writeFile(join(workspace.cwd, "browser-preparation.mjs"), page.preparationModule(), {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(workspace.cwd, "save-page.mjs"), evidenceModule(), {
    flag: "wx",
    mode: 0o600,
  });
}
