import { z } from "zod";
import { codexFailure } from "./errors.js";
import { describeCodexError } from "./error-detail.js";
import type { RpcMessage } from "./rpc-messages.js";
import { turnIdentifier } from "./turn-requests.js";

const turnEvent = z.object({
  id: turnIdentifier,
  status: z.enum(["completed", "failed", "interrupted"]),
  error: z.unknown().optional(),
});
const itemEvent = z.object({
  id: turnIdentifier,
  type: z.string(),
  phase: z.string().nullable().optional(),
  text: z.string().optional(),
});
const observed = ["turn/started", "turn/completed", "item/started", "item/completed"];

/** Owns only one thread and one turn; intermediate internal answers do not finish the call. */
export class TurnNotifications {
  private seenTurn: string | undefined;
  private finalMessage: string | undefined;

  constructor(
    private readonly threadId: string,
    private readonly complete: () => void,
  ) {}

  observeTurn(turnId: string): void {
    if (this.seenTurn && this.seenTurn !== turnId) {
      throw codexFailure("TEXT.CODEX_TURN_CONFLICT");
    }
    this.seenTurn = turnId;
  }

  receive(message: RpcMessage): void {
    const parameters = z.record(z.string(), z.unknown()).parse(message.params ?? {});
    if (parameters.threadId !== this.threadId) {
      return;
    }
    const method = message.method ?? "";
    this.assertNoFailure(method, parameters);
    if (!observed.includes(method)) {
      return;
    }
    const turnId = method.startsWith("turn/")
      ? z.object({ id: turnIdentifier }).parse(parameters.turn).id
      : parameters.turnId;
    this.observeTurn(turnIdentifier.parse(turnId));
    if (method === "turn/completed") {
      this.finish(parameters.turn);
    } else if (method.startsWith("item/")) {
      this.item(method, parameters.item);
    }
  }

  private assertNoFailure(method: string, parameters: Record<string, unknown>): void {
    if (method === "error") {
      throw codexFailure(
        "TEXT.CODEX_TURN_FAILED",
        "unknown",
        describeCodexError(parameters.error ?? parameters.message),
      );
    }
    if (method === "model/rerouted") {
      throw codexFailure("TEXT.CODEX_CONFIG_MISMATCH");
    }
  }

  private finish(raw: unknown): void {
    const turn = turnEvent.parse(raw);
    if (turn.status === "failed") {
      throw codexFailure("TEXT.CODEX_TURN_FAILED", "unknown", describeCodexError(turn.error));
    }
    if (turn.status === "interrupted") {
      throw codexFailure("TEXT.CODEX_CANCELLED");
    }
    if (turn.error != null) {
      throw codexFailure("TEXT.CODEX_PROTOCOL");
    }
    this.complete();
  }

  private item(method: string, raw: unknown): void {
    const item = itemEvent.parse(raw);
    if (
      item.type !== "agentMessage" ||
      method !== "item/completed" ||
      item.phase === "commentary"
    ) {
      return;
    }
    if (item.phase != null && item.phase !== "final_answer") {
      throw codexFailure("TEXT.CODEX_PROTOCOL");
    }
    const text = z.string().min(1).parse(item.text);
    if (Buffer.byteLength(text) > 250000) {
      throw codexFailure("TEXT.CODEX_OUTPUT_LIMIT");
    }
    this.finalMessage = text;
  }

  output(): string {
    if (this.finalMessage === undefined) {
      throw codexFailure("TEXT.CODEX_OUTPUT_MISSING");
    }
    return this.finalMessage;
  }
}
