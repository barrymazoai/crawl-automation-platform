import { expect, it, vi } from "vitest";
import type { CodexRpc } from "./codex-rpc.js";
import { codexFailure } from "./errors.js";
import { TurnExecution } from "./turn-execution.js";

it("observes early TEXT.CODEX_TRANSPORT rejection without consuming the owner's failure", async () => {
  const failure = codexFailure("TEXT.CODEX_TRANSPORT");
  const close = vi.fn(async () => undefined);
  const rpc = {
    close,
    onFailure: (handler: (error: Error) => void) => {
      handler(failure);
      return () => undefined;
    },
    onNotification: () => () => undefined,
  } as unknown as CodexRpc;
  const execution = new TurnExecution(rpc, "thread");
  await expect(execution.done).rejects.toBe(failure);
  expect(execution.failure).toBe(failure);
  expect(close).toHaveBeenCalledOnce();
  execution.unsubscribe();
});
