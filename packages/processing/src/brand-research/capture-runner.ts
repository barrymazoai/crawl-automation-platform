import { EgoAgentPage, runCodexCapture, type CodexCaptureInput } from "@crawl-automation/platform";
import { z } from "zod";
import { archiveWorkspace, type ResearchArchive } from "./archive.js";
import { checkedAnswer } from "./answer.js";
import { closeCapture, type CaptureCleanup } from "./capture-outcome.js";
import type { BrowserPromptInput } from "./browser-prompt.js";
import { brandResearchErrors } from "./errors.js";
import type { BrandSubject } from "./inputs.js";
import type { BrandResearchDeps } from "./settings.js";
import { preparePage, prepareWorkspace, type ResearchWorkspace } from "./workspace.js";

interface CaptureTask<Answer> {
  task: "family" | "research";
  subject: BrandSubject;
  schema: z.ZodType<Answer>;
  prompt(input: BrowserPromptInput): string;
}

/** Template Method: own page → capture → close/verify → publish retained evidence → check answer. */
export class BrandCaptureRunner {
  constructor(private readonly deps: BrandResearchDeps) {}

  async run<Answer>(task: CaptureTask<Answer>, signal: AbortSignal) {
    signal.throwIfAborted();
    const workspace = await prepareWorkspace(this.deps, task);
    let page: EgoAgentPage | undefined;
    let raw: unknown;
    let archive: ResearchArchive | undefined;
    const failures: unknown[] = [];
    try {
      page = await EgoAgentPage.open(this.deps.ego, signal);
      raw = await this.capture({ task, workspace, page }, signal);
    } catch (cause) {
      failures.push(cause);
    } finally {
      archive = await this.finish({ page, workspace, failures });
    }
    if (failures.length || !archive) {
      throw brandResearchErrors.create("BRAND_RESEARCH.EXECUTION_FAILED", {
        cause: new AggregateError(failures),
        details: { prefix: workspace.prefix },
      });
    }
    const answer = checkedAnswer(envelope(task.schema), raw, task.task);
    if (task.task === "research" && !answer.webSearchUsed) {
      throw brandResearchErrors.create("BRAND_RESEARCH.SEARCH_UNAVAILABLE", {
        details: { prefix: workspace.prefix, reason: answer.reason },
      });
    }
    if (answer.status !== "complete" || answer.result === null) {
      throw brandResearchErrors.create("BRAND_RESEARCH.ANSWER_INVALID", {
        details: { task: task.task, reason: answer.reason, prefix: workspace.prefix },
      });
    }
    return { result: answer.result, ...archive };
  }

  private async capture<Answer>(
    input: { task: CaptureTask<Answer>; workspace: ResearchWorkspace; page: EgoAgentPage },
    signal: AbortSignal,
  ) {
    const { task, workspace, page } = input;
    await preparePage(workspace, page);
    const prompt = task.prompt({
      ...workspace,
      subject: task.subject,
      cliPath: this.deps.ego.cliPath,
      taskSpaceId: this.deps.ego.taskSpaceId,
      label: page.label,
      targetId: page.targetId,
    });
    // Platform must honor this opt-in; legacy capture profiles disable web search. See README.md.
    const capture: CodexCaptureInput = {
      cwd: workspace.cwd,
      prompt,
      outputSchema: z.toJSONSchema(envelope(task.schema)),
      environment: this.deps.environment,
      captureMode: "analysis",
      webSearch: task.task === "research" ? "live" : "disabled",
    };
    return runCodexCapture(this.deps.capture, capture, signal);
  }

  private async finish(input: CaptureCleanup) {
    try {
      await closeCapture(input);
    } catch (cause) {
      input.failures.push(cause);
    }
    try {
      return await archiveWorkspace(
        this.deps.publication,
        input.workspace,
        AbortSignal.timeout(300_000),
      );
    } catch (cause) {
      input.failures.push(cause);
      return undefined;
    }
  }
}

function envelope<Answer>(schema: z.ZodType<Answer>) {
  return z.object({
    status: z.enum(["complete", "blocked"]),
    result: schema.nullable(),
    reason: z.string().nullable(),
    webSearchUsed: z.boolean(),
  });
}
