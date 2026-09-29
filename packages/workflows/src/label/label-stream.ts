import {
  ChannelSourceReadySchema,
  ChannelStreamSealSchema,
  assertArtifactBelongsTo,
} from "@crawl-automation/v3-contracts";
import { condition, defineSignal, setHandler } from "@temporalio/workflow";
import { sameJson } from "./same.js";
import type { LabelTask, Source } from "./label-model.js";

/** The pipeline signals each downloaded label image, then seals the stream (closed, or failed). */
export const labelSourceReady = defineSignal<[unknown]>("labelSourceReady");
export const labelStreamSealed = defineSignal<[unknown]>("labelStreamSealed");

type Ready = ReturnType<typeof ChannelSourceReadySchema.parse>;
type Seal = ReturnType<typeof ChannelStreamSealSchema.parse>;

const MAX_FILES = 100;

/** Which sources may start: a page at once, an image once its download is signalled. */
export interface LabelStream {
  ready(source: Source): Promise<boolean>;
  /** True when the stream closed normally and every expected image arrived. */
  finish(): Promise<boolean>;
}

/**
 * The readiness hints from the pipeline. They are only hints: every source is then checked against its durable
 * evidence by the activities, and a signal that does not fit the task marks the whole stream invalid.
 */
export function labelStream(task: LabelTask): LabelStream {
  const files = new Map<string, Ready>();
  const expected = new Set<string>();
  const state: { sealed?: Seal; invalid: boolean } = { invalid: false };
  setHandler(labelSourceReady, (value) => onReady({ task, files, state }, value));
  setHandler(labelStreamSealed, (value) => onSeal({ task, state }, value));
  const settled = () => !!state.sealed || state.invalid;
  return {
    async ready(source) {
      if (source.kind === "page") {
        return true;
      }
      if (source.kind !== "file-image") {
        return false;
      }
      expected.add(source.id);
      await condition(() => files.has(source.id) || settled());
      const ready = files.get(source.id);
      if (!ready || state.invalid) {
        return false;
      }
      state.invalid = !fileFits(ready, source);
      return !state.invalid;
    },
    async finish() {
      await condition(settled);
      const complete =
        files.size === expected.size && [...files.keys()].every((id) => expected.has(id));
      return !state.invalid && state.sealed?.status === "closed" && complete;
    },
  };
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
  } catch {
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
