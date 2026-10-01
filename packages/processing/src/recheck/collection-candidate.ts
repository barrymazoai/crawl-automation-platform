import { sha256 } from "@crawl-automation/platform";
import { LabelCollectedProductSchema } from "@crawl-automation/v3-contracts";
import { encodeJson } from "../results/result-record.js";
import type { RecheckedLabel } from "./assembly-recheck.js";
import { recheckDigest } from "./verified-files.js";
import { recheckErrors } from "./errors.js";

/** Stable plan hash includes both original receipts and today's complete result, including failure codes. */
export function recheckedLabelDigest(label: RecheckedLabel) {
  const { files, ...evidence } = label;
  return recheckDigest({
    ...evidence,
    files: files.map((file) => ({ key: file.key, sha256: sha256(file.bytes) })),
  });
}

/** New collected version, same observation; original task and Review identities stay in its assembly. */
export function recoveredCollection(label: RecheckedLabel) {
  if (label.result.status !== "ready") {
    throw recheckErrors.create("RECHECK.PUBLICATION_UNVERIFIED");
  }
  const { files, ...evidence } = label;
  const operationId = `recovered-${recheckedLabelDigest(label)}`;
  const key = `v3/rechecks/${operationId}/assembly.json`;
  const bytes = encodeJson({ codec: "label-recovery/1", operationId, ...evidence });
  const { result } = label;
  const record = LabelCollectedProductSchema.parse({
    ...(result.packaging
      ? {
          schemaVersion: 4,
          codec: "collected-product/4",
          admissionPolicy: result.admissionPolicy,
          comparisonPolicy: result.comparisonPolicy,
          packaging: result.packaging,
        }
      : { schemaVersion: 3, codec: "collected-product/3" }),
    operationId,
    observation: label.original.manifest.observation,
    assembly: { objectKey: key, sha256: sha256(bytes), byteSize: bytes.length },
    evidencePolicy: result.evidencePolicy,
    formula: result.formula,
    otherIngredients: result.otherIngredients,
    ingredients: result.ingredients,
    warnings: result.warnings,
    provenance: result.provenance,
  });
  return { record, files: [...files, { key, bytes }] };
}
