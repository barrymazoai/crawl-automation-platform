import { handleBrokenConnection, textCatalog } from "./connection-scenarios.js";
import {
  emit,
  threadResult,
  type FixtureMessage,
  type FixtureParameters,
} from "./fixture-protocol.js";
import { runTextTurn } from "./text-turn.js";

function validateThread(parameters: FixtureParameters) {
  if (
    parameters.allowProviderModelFallback !== false ||
    parameters.sandbox !== "read-only" ||
    parameters.ephemeral !== true ||
    parameters.environments.length !== 0
  ) {
    throw Error("Unsafe thread settings");
  }
}

function startThread(message: FixtureMessage, scenario: string): string {
  if (scenario.startsWith("catalog-")) {
    throw Error("Must not start a thread after failed preflight");
  }
  const parameters = message.params;
  const selectedEffort = parameters.config?.model_reasoning_effort;
  if (typeof selectedEffort !== "string" || !selectedEffort) {
    throw Error("Missing effort");
  }
  validateThread(parameters);
  const result = threadResult(parameters, {
    id: "thread-1",
    effort: scenario === "wrong-effort" ? "different-effort" : selectedEffort,
  });
  result.model = scenario === "wrong-model" ? "other" : parameters.model;
  emit({ id: message.id, result });
  return selectedEffort;
}

export function textServer(scenario: string): (message: FixtureMessage) => void {
  let selectedEffort = "";
  const handlers: Record<string, (message: FixtureMessage) => void> = {
    initialize: (message) => emit({ id: message.id, result: {} }),
    initialized: () => undefined,
    "config/read": (message) => {
      const modelProvider = scenario === "catalog-provider" ? "other" : "fixture";
      emit({ id: message.id, result: { config: { model_provider: modelProvider } } });
    },
    "model/list": (message) => emit({ id: message.id, ...textCatalog(scenario) }),
    "thread/start": (message) => {
      selectedEffort = startThread(message, scenario);
    },
    "turn/start": (message) => runTextTurn(message, scenario, selectedEffort),
  };
  return (message) => {
    if (handleBrokenConnection(message, scenario)) {
      return;
    }
    const handle = handlers[message.method ?? ""];
    if (handle) {
      handle(message);
    } else {
      emit({ id: message.id, error: { message: "unexpected method" } });
    }
  };
}
