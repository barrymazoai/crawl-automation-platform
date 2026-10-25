import { join } from "node:path";
import { readMovedOriginal } from "./moved-original.js";
import { dtcAgentErrors } from "./errors.js";
import { readCapturedProduct } from "./product-record.js";
import { retainSiteMethod } from "./site-method.js";
import type { AgentWarning } from "./agent-result.js";
import type { AgentCaptureOutput } from "./capture-output.js";
import type { AgentCaptureDependencies } from "./settings.js";

export async function finishProductOutput(input: {
  deps: AgentCaptureDependencies;
  output: AgentCaptureOutput;
  at: { url: string; warning: AgentWarning | null };
  signal: AbortSignal;
}): Promise<AgentCaptureOutput> {
  const { deps, output, at, signal } = input;
  const { url, warning } = at;
  const result = { ...output, captureContract: "dtc-materials/1" as const };
  // Owner 2026-10-25: only a retained native receipt establishes a moved page.
  if (warning) {
    const moved = await readMovedOriginal({
      root: output.root,
      evidenceFiles: output.evidenceFiles,
      requestedUrl: url,
    });
    if (moved) {
      return { ...output, moved };
    }
  }
  await verifyProductOutput(result, url, warning);
  const method = await retainSiteMethod({
    profileDir: join(deps.settings.codex.workRoot, "site-profiles"),
    root: output.root,
    url,
  });
  await publishHandoff({
    deps,
    output,
    captureContract: result.captureContract,
    method,
    warning,
    signal,
  });
  return result;
}

async function verifyProductOutput(
  result: AgentCaptureOutput,
  url: string,
  warning: AgentWarning | null,
) {
  try {
    await readCapturedProduct({ ...result, url });
  } catch (error) {
    if (warning) {
      throw dtcAgentErrors.create("DTC.CAPTURE_REVIEW", {
        details: {
          result: warning,
          prefix: result.prefix,
          verification: String(error).slice(0, 2000),
        },
      });
    }
    throw error;
  }
}

async function publishHandoff(input: {
  deps: AgentCaptureDependencies;
  output: AgentCaptureOutput;
  captureContract: "dtc-materials/1";
  method: Awaited<ReturnType<typeof retainSiteMethod>>;
  warning: AgentWarning | null;
  signal: AbortSignal;
}) {
  const { deps, output, captureContract, method, warning, signal } = input;
  await deps.publication.publish(
    `${output.prefix}/handoff.json`,
    Buffer.from(
      JSON.stringify({
        captureContract,
        capture: output.manifestKey,
        materials: output.files.find((file) => file.path === "materials.json"),
        method,
        ...(!method ? { methodReview: "validation_record_missing_required_fields" } : {}),
        ...(warning ? { agentWarning: warning } : {}),
      }),
    ),
    "application/json",
    signal,
  );
}
