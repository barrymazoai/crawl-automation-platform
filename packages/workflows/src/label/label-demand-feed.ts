import { FileAcquireOutcomeSchema } from "@crawl-automation/v3-contracts";
import { condition, setHandler, type ChildWorkflowHandle } from "@temporalio/workflow";
import { z } from "zod";
import type { LabelStep } from "./label-step.js";
import { identityConflict } from "./identity-conflict.js";
import { labelSourceRequested, labelSourcesFinished } from "./label-demand-signals.js";

const RequestSchema = z.strictObject({ operationId: z.string(), sourceId: z.string() });
const FinishSchema = z.strictObject({ operationId: z.string() });
type Child = ChildWorkflowHandle<(raw: unknown) => Promise<unknown>>;
interface Demand {
  pending: string[];
  requested: Set<string>;
  closed: boolean;
  invalid: boolean;
  done: boolean;
}

/** Install handlers before starting the child so an immediate text-only completion cannot be lost. */
export function demandFeed(step: LabelStep, labelId: string) {
  const state: Demand = {
    pending: [],
    requested: new Set(),
    closed: false,
    invalid: false,
    done: false,
  };
  const images = new Map(
    step.manifest.sources
      .filter((source) => source.kind === "file-image")
      .map((source) => [source.id, source]),
  );
  setHandler(labelSourceRequested, (raw) => {
    const request = RequestSchema.safeParse(raw);
    if (
      !request.success ||
      request.data.operationId !== labelId ||
      !images.has(request.data.sourceId)
    ) {
      state.invalid = true;
    } else if (!state.requested.has(request.data.sourceId)) {
      state.invalid ||= state.closed || state.pending.length > 0;
      state.requested.add(request.data.sourceId);
      state.pending.push(request.data.sourceId);
    }
  });
  setHandler(labelSourcesFinished, (raw) => {
    const request = FinishSchema.safeParse(raw);
    state.invalid ||=
      !request.success || request.data.operationId !== labelId || state.pending.length > 0;
    state.closed = true;
  });
  return (child: Child) => runDemand(step, { child, labelId, images, state });
}

type Image = Extract<LabelStep["manifest"]["sources"][number], { kind: "file-image" }>;
async function runDemand(
  step: LabelStep,
  at: {
    child: Child;
    labelId: string;
    images: Map<string, Image>;
    state: Demand;
  },
): Promise<null> {
  const { child, labelId, images, state } = at;
  // Observe child failure while waiting too; never leave the parent waiting for a missing signal.
  void child.result().then(
    () => {
      state.done = true;
    },
    () => {
      state.done = true;
    },
  );
  while (!state.closed && !state.done) {
    await condition(() => state.pending.length > 0 || state.closed || state.invalid || state.done);
    if (state.invalid) {
      throw identityConflict();
    }
    const id = state.pending.shift();
    const source = id ? images.get(id) : undefined;
    if (!source) {
      continue;
    }
    await acquireRequested(step, { child, labelId, source });
  }
  if (state.invalid) {
    throw identityConflict();
  }
  return null;
}

async function acquireRequested(
  step: LabelStep,
  at: {
    child: Child;
    labelId: string;
    source: Extract<LabelStep["manifest"]["sources"][number], { kind: "file-image" }>;
  },
) {
  const acquire = at.source.plan.acquire;
  const receipt = FileAcquireOutcomeSchema.parse(
    await step.pipeline.acquireProductFile({
      pipeline: step.input,
      sourcePlan: step.sourcePlan,
      acquire,
    }),
  );
  if (receipt.operationId !== acquire.operationId) {
    throw identityConflict();
  }
  if (receipt.status === "review") {
    await at.child.signal("labelSourceFailed", {
      operationId: at.labelId,
      sourceId: at.source.id,
      receipt,
    });
    return;
  }
  await at.child.signal("labelSourceReady", {
    operationId: at.labelId,
    sourceId: at.source.id,
    file: receipt.file,
  });
}
