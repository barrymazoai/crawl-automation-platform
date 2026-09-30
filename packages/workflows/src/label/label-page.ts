import {
  LabelCoreOutcomeSchema,
  PagePrepareOutcomeSchema,
  PageTextPrepareOutcomeSchema,
  observationIdentity,
} from "@crawl-automation/v3-contracts";
import { isCancellation } from "@temporalio/workflow";
import type { LabelRun } from "./label-run.js";
import type { Source, State } from "./label-model.js";
import { sameJson } from "./same.js";
import { isHeartbeatFailure } from "./activity-heartbeat.js";

type PageSource = Extract<Source, { kind: "page" }>;

/** A page's text document and range for its label task, or the source's final state. */
export type PageOutcome = { document: unknown; range: unknown } | State;

/**
 * A page source: prepare the page (a lost outcome is fine, the page text step reads the durable record), build its
 * text task, and — for a channel with a label core — narrow it to the label facts text.
 */
export async function pageEvidence(run: LabelRun, source: PageSource): Promise<PageOutcome> {
  const receipt = await preparedPage(run, source);
  const text = PageTextPrepareOutcomeSchema.parse(
    await run.call("activities", "preparePageText", { plan: source.plan, receipt }),
  );
  if (text.status === "review") {
    return text.operationId === source.plan.page.operationId
      ? { id: source.id, status: "review", reviewId: text.reviewId }
      : { id: source.id, status: "rejected" };
  }
  const { task } = text;
  const owner = run.entry.input.owner;
  const planned =
    task.operationId === source.plan.textOperationId &&
    task.source.kind === "prepared" &&
    task.source.document.producer.operationId === source.plan.page.operationId &&
    sameJson(observationIdentity(task), owner);
  if (!planned || task.source.kind !== "prepared") {
    return { id: source.id, status: "rejected" };
  }
  const page = { document: task.source.document, range: task.range };
  return run.entry.input.corePolicy
    ? labelCore(run, { source, fullDocument: page.document })
    : page;
}

/** The page's preparation receipt; a lost one is null, since the page text step reads the durable record. */
async function preparedPage(run: LabelRun, source: PageSource) {
  try {
    return PagePrepareOutcomeSchema.parse(
      await run.call("activities", "prepareHtmlPage", source.plan.page),
    );
  } catch (error) {
    if (isCancellation(error) || isHeartbeatFailure(error)) {
      throw error;
    }
    return null;
  }
}

/** The channel's label-core step picks the label facts text out of the full page document. */
async function labelCore(
  run: LabelRun,
  at: { source: PageSource; fullDocument: unknown },
): Promise<PageOutcome> {
  const { input } = run.entry;
  const coreInput = { owner: input.owner, fullDocument: at.fullDocument };
  const core = LabelCoreOutcomeSchema.parse(
    await run.call("activities", "prepareLabelCore", coreInput),
  );
  if (
    !sameJson(core.input, coreInput) ||
    core.document.producer.implementationVersion !== input.corePolicy
  ) {
    return { id: at.source.id, status: "rejected" };
  }
  return { document: core.document, range: core.range };
}
