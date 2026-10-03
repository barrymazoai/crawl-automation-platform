import { z } from "zod";
import { captureFile, type CaptureFile } from "./archive.js";
import { dtcAgentErrors } from "./errors.js";
import { sha256 } from "@crawl-automation/platform";
import { verifyObservedDetails } from "../../../../../crawl-products/lib/observed-details.mjs";

const strings = z.array(z.string().min(1));
const entry = z.object({
  reason: z.string().min(1),
  evidence: strings.min(1),
  imageUrls: z.array(z.url()),
});
const location = z.object({
  source: z.number().int().nonnegative(),
  selector: z.string().optional(),
  pointer: z.string().optional(),
  attribute: z.string().optional(),
  format: z.enum(["raw", "html-text", "html"]).optional(),
});

export const DetailCoverageSchema = z.object({
  version: z.literal("observed-details/1"),
  checkScope: z.literal("website-text").optional(),
  reachedEnd: z.literal(true),
  pageEvidence: strings.min(1),
  sections: z
    .array(
      entry.extend({
        name: z.string().min(1),
        status: z.enum(["captured", "image-only", "excluded", "uninspected"]),
        field: z.string().nullable(),
        location,
      }),
    )
    .min(1),
  checks: z
    .array(
      entry.extend({
        kind: z.enum(["description", "ingredients", "directions", "warnings", "facts"]),
        status: z.enum(["captured", "image-only", "not-present", "uninspected"]),
        fields: strings,
      }),
    )
    .length(5),
});

export const DetailCoverageAuthoringSchema = DetailCoverageSchema.extend({
  checkScope: z.literal("website-text"),
});

/** Historical captures stay readable; every newly produced native capture requires this proof. */
export async function verifyDetailReview(input: {
  root: string;
  record: Parameters<typeof verifyObservedDetails>[1];
  review: { detailCoveragePath?: string | undefined };
  files: CaptureFile[];
  required?: boolean | undefined;
}) {
  const path = input.review.detailCoveragePath;
  if (!path && !input.required) {
    return;
  }
  try {
    if (!path || !input.files.some((file) => file.path === path)) {
      throw new Error("detail_proof_missing");
    }
    const proof = DetailCoverageSchema.parse(
      JSON.parse((await retainedFile(input, path)).toString()),
    );
    if (input.required && proof.checkScope !== "website-text") {
      throw new Error("detail_check_scope_missing");
    }
    const verified = await verifyObservedDetails(input.root, input.record, proof);
    for (const entry of verified.evidence) {
      await retainedFile(input, entry);
    }
  } catch (cause) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE", {
      details: { reason: "detail_coverage_unverified", message: String(cause) },
    });
  }
}

async function retainedFile(input: { root: string; files: CaptureFile[] }, path: string) {
  const file = input.files.find((entry) => entry.path === path);
  const bytes = await captureFile(input.root, path);
  if (!file || file.sha256 !== sha256(bytes) || file.byteSize !== bytes.length) {
    throw new Error("detail_evidence_not_archived");
  }
  return bytes;
}
