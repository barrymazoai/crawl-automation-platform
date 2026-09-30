import { patched } from "@temporalio/workflow";
import { resourceGate, type GatedWork } from "./resource-gate.js";

/** The old implementation is loaded only for histories without this patch marker. */
export function versionedResourceGate(
  raw: unknown,
  options: { ignoreLegacyBinding?: boolean } = {},
) {
  if (patched("resource-gate-v1")) {
    return resourceGate(raw);
  }
  let legacy: Promise<typeof import("@crawl-automation/v3-product/resource-workflow")> | undefined;
  let gate: ReturnType<
    typeof import("@crawl-automation/v3-product/resource-workflow").resourceGate
  >;
  return async <Result>(name: string, run: GatedWork<Result>): Promise<Result> => {
    if (!gate) {
      legacy ??= import(
        /* webpackMode: "eager" */ "@crawl-automation/v3-product/resource-workflow"
      );
      const implementation = await legacy;
      gate ??= implementation.resourceGate(raw);
    }
    return gate(name, (binding) => run(options.ignoreLegacyBinding ? undefined : binding));
  };
}
