import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, it, vi } from "vitest";
import { CodexRpc } from "./codex-rpc.js";
import { codexConnection } from "./connection.js";
import { runCodexTurn } from "./codex-turn.js";
import type { CodexTurnInput } from "./turn-requests.js";
import type { CodexExecutionConfig } from "./connection-settings.js";

const state = vi.hoisted(() => ({ child: null as ChildProcessWithoutNullStreams | null }));
vi.mock("node:child_process", () => ({ spawn: () => state.child }));

// An intentional test-only source oracle: the old package is not a platform runtime dependency.
// Import its actual implementation, not a copied serialization fixture.
const legacy = (await import(new URL("../../../v3-codex/src/index.ts", import.meta.url).href)) as {
  CodexRpc: typeof CodexRpc;
  runCodexTurn(rpc: CodexRpc, input: CodexTurnInput, signal: AbortSignal): Promise<string>;
  codexConnection: typeof codexConnection;
};

interface ClientMessage {
  id?: number;
  method: string;
  params: Record<string, unknown>;
}

function effectiveProvider(provider: string) {
  return provider === "openai" ? "crawler_openai_no_retry" : provider;
}

function readReply(method: string, input: CodexTurnInput) {
  if (method === "config/read") {
    return {
      config: {
        model_provider: effectiveProvider(input.provider),
        model_providers: {
          crawler_openai_no_retry: {
            name: "OpenAI",
            wire_api: "responses",
            requires_openai_auth: true,
            supports_websockets: false,
            request_max_retries: 0,
            stream_max_retries: 0,
          },
        },
      },
    };
  }
  if (method === "model/list") {
    return {
      data: [
        {
          id: "picker",
          model: input.model,
          supportedReasoningEfforts: [{ reasoningEffort: input.reasoningEffort }],
          inputModalities: ["text", "image"],
        },
      ],
      nextCursor: null,
    };
  }
  return {};
}

function threadReply(parameters: Record<string, unknown>) {
  const config = parameters.config as { model_reasoning_effort: string };
  return {
    thread: { id: "thread-one" },
    model: parameters.model,
    modelProvider: parameters.modelProvider,
    cwd: parameters.cwd,
    approvalPolicy: "never",
    sandbox: { type: "readOnly" },
    reasoningEffort: config.model_reasoning_effort,
  };
}

function answerTurn(send: (message: object) => void) {
  const common = { threadId: "thread-one", turnId: "turn-one" };
  send({ method: "turn/started", params: { ...common, turn: { id: "turn-one" } } });
  send({
    method: "item/completed",
    params: {
      ...common,
      item: { id: "answer", type: "agentMessage", phase: "final_answer", text: ' {"ok":true} ' },
    },
  });
  send({
    method: "turn/completed",
    params: {
      ...common,
      turn: { id: "turn-one", status: "completed", error: null },
    },
  });
}

function respondingChild(input: CodexTurnInput, serverRequest = false) {
  const sent: Buffer[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit("close"));
      return true;
    }),
  });
  const send = (message: object) => {
    child.stdout.write(JSON.stringify(message) + "\n");
  };
  child.stdin.on("data", (chunk: Buffer) => {
    sent.push(Buffer.from(chunk));
    const message = JSON.parse(chunk.toString()) as ClientMessage;
    if (serverRequest) {
      if (message.method) {
        send({ id: "server-one", method: "item/tool/call", params: {} });
      }
      return;
    }
    if (message.method === "initialized") {
      return;
    }
    let result: unknown = readReply(message.method, input);
    if (message.method === "thread/start") {
      result = threadReply(message.params);
    }
    if (message.method === "turn/start") {
      answerTurn(send);
      result = { turn: { id: "turn-one" } };
    }
    send({ id: message.id, result });
  });
  state.child = child as unknown as ChildProcessWithoutNullStreams;
  return sent;
}

const connectionOptions = { executable: "unused", args: [], cwd: process.cwd(), env: {} };
const input: CodexTurnInput = {
  model: "fixture-model",
  provider: "fixture",
  reasoningEffort: "fixture-effort",
  cwd: process.cwd(),
  prompt: 'untrusted evidence\n"quoted" 雪',
  outputSchema: { type: "object" },
};

it.each([
  { provider: "fixture", image: false },
  { provider: "fixture", image: true },
  { provider: "openai", image: false },
  { provider: "openai", image: true },
])("sends byte-identical JSON-RPC for %o", async (scenario) => {
  const selected = {
    ...input,
    provider: scenario.provider,
    ...(scenario.image
      ? { image: { path: "original image.png", detail: "original" as const } }
      : {}),
  };
  const previous = respondingChild(selected);
  const expected = await legacy.runCodexTurn(
    new legacy.CodexRpc(connectionOptions),
    selected,
    AbortSignal.timeout(1000),
  );
  const current = respondingChild(selected);
  const actual = await runCodexTurn(new CodexRpc(connectionOptions), selected, {
    signal: AbortSignal.timeout(1000),
  });
  expect(actual).toBe(expected);
  expect(actual).toBe(' {"ok":true} ');
  expect(current).toHaveLength(6);
  expect(current).toEqual(previous);
  expect(Buffer.concat(current).equals(Buffer.concat(previous))).toBe(true);
});

it("sends the identical refusal for a server-side tool/auth request", async () => {
  const previous = respondingChild(input, true);
  const oldConnection = new legacy.CodexRpc(connectionOptions);
  await expect(oldConnection.initialize(AbortSignal.timeout(1000))).rejects.toMatchObject({
    code: "TEXT.CODEX_SERVER_REQUEST",
  });
  await oldConnection.close();
  const current = respondingChild(input, true);
  const connection = new CodexRpc(connectionOptions);
  await expect(connection.initialize(AbortSignal.timeout(1000))).rejects.toMatchObject({
    code: "TEXT.CODEX_SERVER_REQUEST",
  });
  await connection.close();
  expect(current).toHaveLength(2);
  expect(current).toEqual(previous);
});

it.each(["openai", "fixture"])("preserves every child option for provider %s", (provider) => {
  const config: CodexExecutionConfig = {
    settings: { model: input.model, provider, reasoningEffort: input.reasoningEffort },
    executable: process.execPath,
    codexHome: process.cwd(),
    workRoot: process.cwd(),
    runtimeProfileVersion: "fixture/1",
    timeoutMs: 5000,
    disabledMcpServers: ["one", "two"],
  };
  const environment = { PATH: "fixture", HTTP_PROXY: "http://proxy.invalid", SECRET: "excluded" };
  expect(codexConnection(config, input.cwd, environment)).toEqual(
    legacy.codexConnection(config, input.cwd, environment),
  );
});
