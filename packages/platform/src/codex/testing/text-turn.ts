import { readFileSync } from "node:fs";
import { emit, notify, type FixtureMessage, type FixtureParameters } from "./fixture-protocol.js";

const common = { threadId: "thread-1", turnId: "turn-1" };

function validateLabel(parameters: FixtureParameters, selectedEffort: string) {
  if (
    parameters.outputSchema?.properties?.codec?.const !== "label-extraction/1" ||
    !parameters.input?.[0]?.text?.includes("SAME ROW") ||
    selectedEffort !== "medium"
  ) {
    throw Error("Label protocol was not passed through");
  }
}

function validateTurn(parameters: FixtureParameters, scenario: string, selectedEffort: string) {
  if (scenario === "wrong-effort") {
    throw Error("Must not start a turn after config mismatch");
  }
  if (parameters.effort !== selectedEffort) {
    throw Error("Effort was not passed through");
  }
  if (scenario === "label-result") {
    validateLabel(parameters, selectedEffort);
  }
}

function emitInternalEvents(scenario: string): boolean {
  notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
  if (scenario.startsWith("raw-")) {
    notify("rawResponseItem/completed", { ...common, item: { type: scenario.slice(4) } });
  }
  if (scenario === "internal-recovery" || scenario === "internal-hang") {
    for (let i = 0; i < 3; i++) {
      notify("error", { ...common, error: { message: "Internal recovery" }, willRetry: true });
    }
    if (scenario === "internal-hang") {
      return true;
    }
  }
  if (scenario === "rerouted") {
    notify("model/rerouted", { ...common, fromModel: "fixture-model", toModel: "other-model" });
    return true;
  }
  notify("rawResponseItem/completed", { ...common, item: { type: "reasoning" } });
  notify("rawResponseItem/completed", { ...common, item: { type: "message" } });
  return scenario === "hang-turn";
}

function emitAnswer(scenario: string) {
  notify("item/completed", {
    ...common,
    item: {
      id: "comment",
      type: "agentMessage",
      phase: "commentary",
      text: "not the final result",
    },
  });
  const answer =
    scenario === "label-result"
      ? readFileSync(process.argv[3] as string, "utf8")
      : ' {"formula":null,"ingredients":null} ';
  notify("item/completed", {
    ...common,
    item: { id: "answer", type: "agentMessage", phase: "final_answer", text: answer },
  });
  if (scenario === "ambiguous") {
    notify("item/completed", {
      ...common,
      item: { id: "answer-2", type: "agentMessage", text: "{}" },
    });
  }
}

export function runTextTurn(message: FixtureMessage, scenario: string, selectedEffort: string) {
  validateTurn(message.params, scenario, selectedEffort);
  if (emitInternalEvents(scenario)) {
    emit({ id: message.id, result: { turn: { id: "turn-1" } } });
    return;
  }
  if (scenario === "tool") {
    notify("item/started", { ...common, item: { id: "tool-1", type: "commandExecution" } });
  }
  if (scenario !== "missing") {
    emitAnswer(scenario);
  }
  notify("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: scenario === "failed-turn" ? "failed" : "completed",
      error: null,
    },
  });
  emit({
    id: message.id,
    result: { turn: { id: scenario === "wrong-turn" ? "other-turn" : "turn-1" } },
  });
}
