import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { EgoAgentPage, runCodexCapture, sha256 } from "@crawl-automation/platform";
import type { AgentCaptureDependencies } from "./settings.js";
export type { AgentCaptureDependencies } from "./settings.js";
import { captureOutputFiles, retainCaptureDirectory, type CaptureFile } from "./archive.js";
import { dtcAgentErrors } from "./errors.js";
import { capturePrompt } from "./prompt.js";
import type { AgentCaptureRequest } from "./request.js";
import { prepareSiteMethod, retainSiteMethod } from "./site-method.js";
import { readCapturedProduct } from "./product-record.js";

const ResultSchema = z.strictObject({
  status: z.enum(["complete", "needs_review", "failed"]),
  summary: z.string(),
  reasonCode: z.string().nullable(),
});
interface AgentCaptureOutput {
  root: string;
  prefix: string;
  files: CaptureFile[];
  evidenceFiles: CaptureFile[];
  manifestKey: string;
  requireDetailCoverage?: boolean;
  captureContract?: "dtc-materials/1";
}

export class DtcCaptureAgent {
  constructor(private readonly deps: AgentCaptureDependencies) {}

  async capture(request: AgentCaptureRequest, signal: AbortSignal): Promise<AgentCaptureOutput> {
    const { ego, publication } = this.deps;
    const { cwd, outDir, prefix } = await this.prepare(request);
    let page: EgoAgentPage | undefined;
    let files: CaptureFile[] = [];
    try {
      page = await EgoAgentPage.open(ego, signal);
      await this.run(request, { cwd, outDir, prefix, page }, signal);
    } finally {
      files = await this.finish(page, { cwd, prefix });
    }
    const retained = captureOutputFiles(files);
    const manifestKey = `${prefix}/capture.json`;
    await publication.publish(
      manifestKey,
      Buffer.from(JSON.stringify({ request, ...retained })),
      "application/json",
      signal,
    );
    const output = { root: outDir, prefix, ...retained, manifestKey };
    if (request.mode !== "product") {
      return output;
    }
    return this.productOutput(output, request.url, signal);
  }

  private async productOutput(output: AgentCaptureOutput, url: string, signal: AbortSignal) {
    const { prefix, manifestKey, root } = output;
    const { publication } = this.deps;
    const result = { ...output, captureContract: "dtc-materials/1" as const };
    await readCapturedProduct({ ...result, url });
    const method = await retainSiteMethod({
      profileDir: join(this.deps.settings.codex.workRoot, "site-profiles"),
      root,
      url,
    });
    await publication.publish(
      `${prefix}/handoff.json`,
      Buffer.from(
        JSON.stringify({
          captureContract: result.captureContract,
          capture: manifestKey,
          materials: output.files.find((file) => file.path === "materials.json"),
          method,
        }),
      ),
      "application/json",
      signal,
    );
    return result;
  }

  private async prepare(request: AgentCaptureRequest) {
    const { operationId } = request;
    const { settings } = this.deps;
    const root = join(settings.codex.workRoot, "dtc-native");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const cwd = join(root, sha256(Buffer.from(operationId)));
    await mkdir(cwd, { mode: 0o700 });
    const outDir = join(cwd, "capture");
    await mkdir(outDir, { mode: 0o700 });
    await mkdir(join(settings.codex.workRoot, "site-profiles"), { recursive: true, mode: 0o700 });
    const prefix = `v3/dtc-agent/${operationId}`;
    await this.skills(cwd);
    return { cwd, outDir, prefix };
  }

  private async run(
    request: AgentCaptureRequest,
    at: { cwd: string; outDir: string; prefix: string; page: EgoAgentPage },
    signal: AbortSignal,
  ) {
    const { cwd, outDir, page, prefix } = at;
    const { settings, ego } = this.deps;
    await writeFile(join(cwd, "browser-preparation.mjs"), page.preparationModule(), { flag: "wx" });
    await this.method(request, at);
    const prompt = capturePrompt({
      ...request,
      cwd,
      outDir,
      skillRoot: this.deps.skillRoot,
      egoSkillPath: settings.egoSkillPath,
      profileDir: join(settings.codex.workRoot, "site-profiles"),
      cliPath: ego.cliPath,
      taskSpaceId: ego.taskSpaceId,
      label: page.label,
      targetId: page.targetId,
    });
    const result = ResultSchema.parse(
      await runCodexCapture(
        settings.codex,
        {
          cwd,
          prompt,
          outputSchema: z.toJSONSchema(ResultSchema),
          environment: this.deps.environment,
          captureMode: request.mode,
          profileDir: join(settings.codex.workRoot, "site-profiles"),
          writableDirectories: [join(settings.codex.workRoot, "site-profiles")],
        },
        signal,
      ),
    );
    if (result.status !== "complete") {
      throw dtcAgentErrors.create("DTC.CAPTURE_REVIEW", { details: { result, prefix } });
    }
  }

  private async method(
    request: AgentCaptureRequest,
    at: { cwd: string; outDir: string; page: EgoAgentPage },
  ) {
    if (request.mode !== "product") {
      return;
    }
    const { cwd, outDir, page } = at;
    await prepareSiteMethod({
      cwd,
      outDir,
      productUrl: request.url,
      skillRoot: this.deps.skillRoot,
      profileDir: join(this.deps.settings.codex.workRoot, "site-profiles"),
      taskSpaceId: this.deps.ego.taskSpaceId,
      label: page.label,
      targetId: page.targetId,
    });
  }

  private async skills(cwd: string): Promise<void> {
    const paths = [join(this.deps.skillRoot, "SKILL.md"), this.deps.settings.egoSkillPath];
    const skills = await Promise.all(
      paths.map(async (path) => ({ path: resolve(path), sha256: sha256(await readFile(path)) })),
    );
    await writeFile(join(cwd, "skills.json"), JSON.stringify(skills), { flag: "wx", mode: 0o600 });
  }

  private async finish(
    page: EgoAgentPage | undefined,
    input: { cwd: string; prefix: string },
  ): Promise<CaptureFile[]> {
    let files: CaptureFile[] = [];
    try {
      await page?.close();
    } finally {
      const signal = AbortSignal.timeout(300_000);
      files = await retainCaptureDirectory(
        this.deps.publication,
        { root: input.cwd, prefix: input.prefix },
        signal,
      );
      await this.deps.publication.publish(
        `${input.prefix}/archive.json`,
        Buffer.from(JSON.stringify({ files })),
        "application/json",
        signal,
      );
    }
    return files;
  }
}
