import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  emit,
  notify,
  threadResult,
  type FixtureMessage,
  type FixtureParameters,
} from "./fixture-protocol.js";

function imageHash(parameters: FixtureParameters, thread?: FixtureParameters) {
  const image = parameters.input[1];
  if (
    parameters.input.length !== 2 ||
    image.type !== "localImage" ||
    image.detail !== "original" ||
    parameters.effort !== "medium" ||
    thread?.sandbox !== "read-only"
  ) {
    throw Error("INVALID_IMAGE_TURN");
  }
  return createHash("sha256").update(readFileSync(image.path)).digest("hex");
}

function labelAnswer(parameters: FixtureParameters, hash: string) {
  if (
    parameters.outputSchema?.properties?.codec?.const !== "label-extraction/1" ||
    !parameters.input[0].text.includes("SAME row")
  ) {
    throw Error("INVALID_LABEL_PROTOCOL");
  }
  const fixture = JSON.parse(readFileSync(process.argv[3] as string, "utf8")) as {
    imageSha256: string;
    candidate: unknown;
  };
  if (fixture.imageSha256 !== hash) {
    throw Error("ORIGINAL_BYTES_CHANGED");
  }
  return JSON.stringify(fixture.candidate);
}

function imageAnswer(parameters: FixtureParameters, scenario: string, thread?: FixtureParameters) {
  if (scenario === "vision-multiple") {
    if (parameters.input.length !== 3) {
      throw Error("INVALID_MULTIPLE_IMAGE_TURN");
    }
    const [text, ...images] = parameters.input;
    return JSON.stringify({
      hashes: images.map((image) => imageHash({ ...parameters, input: [text, image] }, thread)),
    });
  }
  const hash = imageHash(parameters, thread);
  return scenario === "label-result" ? labelAnswer(parameters, hash) : JSON.stringify({ hash });
}

function visionCatalog(scenario: string) {
  return {
    data: [
      {
        id: "fixture",
        model: "fixture",
        inputModalities: scenario === "text-only" ? ["text"] : ["text", "image"],
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      },
    ],
    nextCursor: null,
  };
}

function answerTurn(message: FixtureMessage, answer: string | undefined) {
  emit({ id: message.id, result: { turn: { id: "turn" } } });
  notify("item/completed", {
    threadId: "thread",
    turnId: "turn",
    item: { id: "answer", type: "agentMessage", phase: "final_answer", text: answer },
  });
  notify("turn/completed", {
    threadId: "thread",
    turn: { id: "turn", status: "completed", error: null },
  });
}

export function visionServer(scenario: string): (message: FixtureMessage) => void {
  let thread: FixtureParameters | undefined;
  const handlers: Record<string, (message: FixtureMessage) => void> = {
    initialize: (message) => emit({ id: message.id, result: {} }),
    initialized: () => undefined,
    "config/read": (message) => {
      emit({ id: message.id, result: { config: { model_provider: "fixture" } } });
    },
    "model/list": (message) => emit({ id: message.id, result: visionCatalog(scenario) }),
    "thread/start": (message) => {
      thread = message.params;
      const effort = thread.config?.model_reasoning_effort;
      emit({ id: message.id, result: threadResult(thread, { id: "thread", effort }) });
    },
    "turn/start": (message) => answerTurn(message, imageAnswer(message.params, scenario, thread)),
  };
  return (message) => {
    const handle = handlers[message.method ?? ""];
    if (!handle) {
      throw Error("Unexpected method");
    }
    handle(message);
  };
}
