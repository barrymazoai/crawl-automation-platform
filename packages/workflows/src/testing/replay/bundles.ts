import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
import ts from "typescript";

export const pipelineMarkers = [
  "capture-mode-v1",
  "shared-label-workflow-v1",
  "formula-reuse-v1",
  "formula-reuse-ocr-v1",
  "resource-gate-v1",
  "download-heartbeat-v1",
  "label-heartbeat-v1",
] as const;
export const labelMarkers = ["resource-gate-v1", "label-heartbeat-v1"] as const;
export const labelNoSourceMarker = "label-no-source-review-v1";
export type PatchMarker =
  | (typeof pipelineMarkers)[number]
  | typeof labelNoSourceMarker
  | "formula-family-capture-v1"
  | "brand-listing-gap-v1"
  | "browser-scan-permit-v1";
export type ReplayBundle = { code: string };

export function currentBundle() {
  return bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL("../../workflows.ts", import.meta.url)),
  });
}

export function childBundle() {
  return bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL("./child-workflows.ts", import.meta.url)),
  });
}

/**
 * Recording only: remove selected patch calls from an in-memory copy of the compiled application.
 * This executes the retained old branches with the real SDK and server, producing genuine histories
 * without those markers. Replay ALWAYS uses the untouched current bundle and real patched().
 * TypeScript's parser locates calls, so source-map strings and unrelated SDK patches stay untouched.
 */
export function withoutPatches(
  bundle: ReplayBundle,
  markers: readonly PatchMarker[],
): ReplayBundle {
  const source = ts.createSourceFile("recording.js", bundle.code, ts.ScriptTarget.Latest, true);
  const replacements: Array<{ start: number; end: number; marker: PatchMarker }> = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isPatched(node.expression)) {
      const argument = node.arguments[0];
      const marker = argument && ts.isStringLiteral(argument) ? argument.text : undefined;
      const selected = markers.find((candidate) => candidate === marker);
      if (selected) {
        replacements.push({ start: node.getStart(source), end: node.end, marker: selected });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const marker of markers) {
    if (!replacements.some((replacement) => replacement.marker === marker)) {
      throw new Error(`Recording bundle has no patched() call for ${marker}`);
    }
  }
  let code = bundle.code;
  for (const { start, end } of replacements.sort((left, right) => right.start - left.start)) {
    code = code.slice(0, start) + "false".padEnd(end - start) + code.slice(end);
  }
  return { code };
}

function isPatched(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return isPatched(expression.expression);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return isPatched(expression.right);
  }
  return ts.isPropertyAccessExpression(expression) && expression.name.text === "patched";
}
