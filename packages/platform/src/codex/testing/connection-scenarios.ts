import { emit, type FixtureMessage } from "./fixture-protocol.js";

const brokenConnections: Record<string, (message: FixtureMessage) => void> = {
  malformed: () => {
    process.stdout.write("invalid JSON\n");
  },
  envelope: (message) => {
    emit({ id: message.id });
  },
  silence: () => undefined,
  crash: () => {
    process.exit(3);
  },
  "server-request": () => {
    emit({ id: "server-1", method: "item/tool/call", params: {} });
  },
  oversized: () => {
    process.stdout.write("x".repeat(2100000));
  },
};

export function handleBrokenConnection(message: FixtureMessage, scenario: string): boolean {
  const handle = brokenConnections[scenario];
  if (!handle) {
    return false;
  }
  handle(message);
  return true;
}

export function textCatalog(scenario: string) {
  if (scenario === "catalog-error") {
    return { error: { message: "private failure" } };
  }
  const efforts = scenario === "catalog-effort" ? ["low"] : ["low", "medium", "high"];
  const model = {
    id: "picker-entry",
    model: "fixture-model",
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
    inputModalities: scenario === "catalog-image" ? ["image"] : ["text"],
  };
  return { result: { data: scenario === "catalog-missing" ? [] : [model], nextCursor: null } };
}
