import { CodexModelSettingsSchema } from "@crawl-automation/v3-contracts";
import type { CodexRpc } from "./codex-rpc.js";
import { assertCodexModel } from "./codex-preflight.js";
import { TurnExecution } from "./turn-execution.js";
import {
  threadRequest,
  turnRequest,
  turnReply,
  verifiedThread,
  type CodexTurnInput,
} from "./turn-requests.js";

export interface CodexTurnOptions {
  signal: AbortSignal;
  timeoutMs?: number;
}

async function initializeThread(rpc: CodexRpc, input: CodexTurnInput, signal: AbortSignal) {
  const settings = CodexModelSettingsSchema.parse({
    model: input.model,
    provider: input.provider,
    reasoningEffort: input.reasoningEffort,
  });
  signal.throwIfAborted();
  await rpc.initialize(signal);
  await assertCodexModel(rpc, settings, {
    cwd: input.cwd,
    signal,
    modalities: input.image || input.images?.length ? ["text", "image"] : ["text"],
  });
  const reply = await rpc.request("thread/start", threadRequest(settings, input.cwd), signal);
  return { settings, threadId: verifiedThread(reply, settings, input.cwd) };
}

/** One business execution: one thread/turn, any number of Codex-managed internal model requests. */
export async function runCodexTurn(
  rpc: CodexRpc,
  input: CodexTurnInput,
  options: CodexTurnOptions,
): Promise<string> {
  const lifetime = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeoutMs ?? 240000),
  ]);
  let execution: TurnExecution | undefined;
  const abort = () => {
    void rpc.close();
  };
  lifetime.addEventListener("abort", abort, { once: true });
  try {
    const { settings, threadId } = await initializeThread(rpc, input, lifetime);
    execution = new TurnExecution(rpc, threadId);
    const started = turnReply.parse(
      await rpc.request("turn/start", turnRequest(threadId, settings, input), lifetime),
    );
    execution.notifications.observeTurn(started.turn.id);
    await execution.done;
    if (execution.failure) {
      throw execution.failure;
    }
    lifetime.throwIfAborted();
    return execution.notifications.output();
  } catch (error) {
    // A notice can reject turn/start via close(); retain that reason, not CLOSED.
    throw execution?.failure ?? error;
  } finally {
    execution?.unsubscribe();
    lifetime.removeEventListener("abort", abort);
    await rpc.close({ proveStopped: true });
  }
}
