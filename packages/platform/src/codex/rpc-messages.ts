import { codexFailure } from "./errors.js";
import { describeCodexError } from "./error-detail.js";

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface MessageContext {
  pending: Map<number, PendingRequest>;
  listeners: Set<(message: RpcMessage) => void>;
  send(message: object): void;
  fail(error: Error): void;
}

function reply(message: RpcMessage, pendingRequests: Map<number, PendingRequest>): void {
  if (typeof message.id !== "number") {
    throw codexFailure("TEXT.CODEX_PROTOCOL");
  }
  const pending = pendingRequests.get(message.id);
  if (!pending || (message.error === undefined && !("result" in message))) {
    throw codexFailure("TEXT.CODEX_PROTOCOL");
  }
  pendingRequests.delete(message.id);
  if (message.error !== undefined) {
    pending.reject(
      codexFailure("TEXT.CODEX_REQUEST_FAILED", "unknown", describeCodexError(message.error)),
    );
  } else {
    pending.resolve(message.result);
  }
}

export function receiveMessage(raw: unknown, context: MessageContext): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw codexFailure("TEXT.CODEX_PROTOCOL");
  }
  const message = raw as RpcMessage;
  if (message.method && message.id !== undefined) {
    context.send({
      id: message.id,
      error: { code: -32601, message: "Client-side tool/auth requests are not supported" },
    });
    context.fail(codexFailure("TEXT.CODEX_SERVER_REQUEST"));
  } else if (message.id !== undefined) {
    reply(message, context.pending);
  } else {
    if (typeof message.method !== "string") {
      throw codexFailure("TEXT.CODEX_PROTOCOL");
    }
    for (const listener of context.listeners) {
      listener(message);
    }
  }
}
