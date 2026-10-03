export interface FixtureParameters {
  model: string;
  modelProvider: string;
  cwd: string;
  config?: { model_reasoning_effort?: string };
  allowProviderModelFallback: boolean;
  sandbox: string;
  ephemeral: boolean;
  environments: unknown[];
  effort: string;
  input: [
    { text: string },
    { type: string; detail: string; path: string },
    ...{ type: string; detail: string; path: string }[],
  ];
  outputSchema?: { properties?: { codec?: { const?: string } } };
}

export interface FixtureMessage {
  id?: number | string;
  method?: string;
  params: FixtureParameters;
}

export function emit(value: object): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

export function notify(method: string, params: object): void {
  emit({ method, params });
}

export function threadResult(
  parameters: FixtureParameters,
  options: { id: string; effort: string | undefined },
) {
  return {
    thread: { id: options.id },
    model: parameters.model,
    modelProvider: parameters.modelProvider,
    cwd: parameters.cwd,
    reasoningEffort: options.effort,
    approvalPolicy: "never",
    sandbox: { type: "readOnly" },
  };
}
