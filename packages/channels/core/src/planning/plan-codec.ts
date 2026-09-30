import { createHash } from "node:crypto";
import { ChannelPlanInputSchema, type ChannelPlanInput } from "@crawl-automation/v3-contracts";

/** A saved plan is at most this large. */
export const PLAN_LIMIT = 8 * 1024 * 1024;
/** The retained page projection a plan is built from. */
export const SOURCE_LIMIT = 4 * 1024 * 1024;
/** The derived facts/details fragment the text step reads. */
export const FRAGMENT_LIMIT = 2 * 1024 * 1024;

const hex = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export const encodeJson = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

export function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export const planKey = (input: ChannelPlanInput) =>
  `v3/channel-plans/${input.operationId}/plan.json`;

export const planFingerprint = (input: ChannelPlanInput) =>
  hex(encodeJson(ChannelPlanInputSchema.parse(input)));

/** The operation ID of one planned task (`page`, `text`, `file-0`, …) of a plan operation. */
export const planTaskId = (operationId: string, role: string) =>
  `chp-${hex(encodeJson([operationId, role]))}`;

/** The same page policy fingerprint the page step has always used (page.prepare/1). */
export const PAGE_CONFIG_FINGERPRINT = hex(
  JSON.stringify([
    "page.prepare/1",
    {
      maxBytes: 2 * 1024 * 1024,
      maxOutputBytes: 8 * 1024 * 1024,
      maxNodes: 100000,
      maxDepth: 128,
      maxTables: 200,
      maxCells: 20000,
    },
  ]),
);

export { FILE_CONFIG_FINGERPRINT, acquiredImageId } from "../files/file-policy.js";

/** A fingerprinted task input: the fingerprint field is hashed over its own canonical material. */
export const fingerprinted = (material: string) => hex(Buffer.from(material));
