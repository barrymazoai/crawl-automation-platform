import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";

export function gateBundle(legacy = false) {
  return bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL("./gate-workflows.ts", import.meta.url)),
    webpackConfigHook: (config) => {
      if (legacy) {
        // Swap only the dispatcher, so all callers run the actual old gate without the new marker.
        const replacement = fileURLToPath(new URL("./legacy-gate.ts", import.meta.url));
        config.resolve = {
          ...config.resolve,
          alias: {
            ...config.resolve?.alias,
            [fileURLToPath(new URL("../versioned-gate.js", import.meta.url))]: replacement,
            "./resources/versioned-gate.js": replacement,
            "../resources/versioned-gate.js": replacement,
            "./versioned-gate.js": replacement,
            "../versioned-gate.js": replacement,
          },
        };
      }
      return config;
    },
  });
}
