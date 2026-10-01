import { recordWorkflowRecovery } from "../workflow-recovery.js";
import {
  ChannelSourceReadySchema,
  ChannelStreamSealSchema,
  assertArtifactBelongsTo,
} from "@crawl-automation/v3-contracts";
import { condition, defineSignal, setHandler } from "@temporalio/workflow";
import { sameJson } from "./same.js";
import type { LabelTask, Source, State } from "./label-model.js";
import { demandSignals } from "./label-demand-signals.js";
import { streamFailures } from "./label-stream-failures.js";

/** The pipeline signals each downloaded label image, then seals the stream (closed, or failed). */
export const labelSourceReady = defineSignal<[unknown]>("labelSourceReady");
export const labelStreamSealed = defineSignal<[unknown]>("labelStreamSealed");

type Ready = ReturnType<typeof ChannelSourceReadySchema.parse>;
type Seal = ReturnType<typeof ChannelStreamSealSchema.parse>;

const MAX_FILES = 100;

/** Which sources may start: a page at once, an image once its download is signalled. */
export interface LabelStream {
  demand?: boolean;
  failure?(source: Source): State | undefined;
  ready(source: Source): Promise<boolean>;
  /** True when the stream closed normally and every expected image arrived. */
  finish(): Promise<boolean>;
}

/**
 * The readiness hints from the pipeline. They are only hints: every source is then checked against its durable
 * evidence by the activities, and a signal that does not fit the task marks the whole stream invalid.
 */
export function labelStream(task: LabelTask, demand = false): LabelStream {
  const signals = demand ? demandSignals(task) : null;
  const files = new Map<string, Ready>();
  const expected = new Set<string>();
  const state: { sealed?: Seal; invalid: boolean } = { invalid: false };
  const failures = demand
    ? streamFailures(task, () => {
        state.invalid = true;
      })
    : null;
  setHandler(labelSourceReady, (value) => onReady({ task, files, state }, value));
  setHandler(labelStreamSealed, (value) => onSeal({ task, state }, value));
  const settled = () => !!state.sealed || state.invalid;
  return {
    demand,
    failure: (source) => failures?.state(source),
    async ready(source) {
      if (source.kind === "page") {
        return true;
      }
      if (source.kind !== "file-image") {
        return false;
      }
      expected.add(source.id);
      if (signals) {
        await signals.request(source.id);
      }
      await condition(() => files.has(source.id) || !!failures?.failed.has(source.id) || settled());
      const ready = files.get(source.id);
      if (!ready || state.invalid) {
        return false;
      }
      state.invalid = !fileFits(ready, source);
      return !state.invalid;
    },
    finish: () => finishStream({ signals, failures, files, expected, state }),
  };
}

async function finishStream(at: {
  signals: ReturnType<typeof demandSignals> | null;
  failures: ReturnType<typeof streamFailures> | null;
  files: Map<string, Ready>;
  expected: Set<string>;
  state: { sealed?: Seal; invalid: boolean };
}) {
  const { signals, failures, files, expected, state } = at;
  if (signals) {
    await signals.finish();
  }
  await condition(() => !!state.sealed || state.invalid);
  const arrived = [...files.keys(), ...(failures?.failed.keys() ?? [])];
  const complete =
    arrived.length === expected.size &&
    new Set(arrived).size === expected.size &&
    arrived.every((id) => expected.has(id));
  return !state.invalid && state.sealed?.status === "closed" && complete;
}

function onReady(
  target: {
    task: LabelTask;
    files: Map<string, Ready>;
    state: { sealed?: Seal; invalid: boolean };
  },
  value: unknown,
): void {
  const { task, files, state } = target;
  const ready = ChannelSourceReadySchema.safeParse(value);
  if (!ready.success || ready.data.operationId !== task.operationId || !belongs(ready.data, task)) {
    state.invalid = true;
    return;
  }
  const prior = files.get(ready.data.sourceId);
  if (prior) {
    state.invalid ||= !sameJson(prior, ready.data);
    return;
  }
  if (state.sealed || files.size >= MAX_FILES) {
    state.invalid = true;
    return;
  }
  files.set(ready.data.sourceId, ready.data);
}

function onSeal(
  target: { task: LabelTask; state: { sealed?: Seal; invalid: boolean } },
  value: unknown,
): void {
  const { task, state } = target;
  const seal = ChannelStreamSealSchema.safeParse(value);
  if (!seal.success || seal.data.operationId !== task.operationId) {
    state.invalid = true;
  } else if (state.sealed && state.sealed.status !== seal.data.status) {
    state.invalid = true;
  } else {
    state.sealed = seal.data;
  }
}

function belongs(ready: Ready, task: LabelTask): boolean {
  try {
    assertArtifactBelongsTo(ready.file, task.owner);
    return true;
  } catch (error) {
    recordWorkflowRecovery(error, { operation: "label/label-stream" });
    return false;
  }
}

/** The downloaded file is exactly the one this image source planned. */
function fileFits(ready: Ready, source: Extract<Source, { kind: "file-image" }>): boolean {
  const { file } = ready;
  const plan = source.plan.acquire;
  return (
    file.kind === "source-image" &&
    file.artifactId === source.plan.imageId &&
    file.producer.operationId === plan.operationId &&
    file.producer.module === "file.acquire" &&
    file.producer.implementationVersion === plan.implementationVersion
  );
}
