import { resourceGate } from "@crawl-automation/v3-product/resource-workflow";
import type { GatedWork } from "../resource-gate.js";

/** Old callers ignored capture bindings, but used label bindings; the old gate is otherwise unchanged. */
export function versionedResourceGate(
  raw: unknown,
  options: { ignoreLegacyBinding?: boolean } = {},
) {
  const gate = resourceGate(raw);
  return <Result>(name: string, run: GatedWork<Result>) =>
    gate(name, (binding) => run(options.ignoreLegacyBinding ? undefined : binding));
}
