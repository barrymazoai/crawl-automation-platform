import ipaddr from "ipaddr.js";
import { z } from "zod";
import { sha256 } from "@crawl-automation/platform";
import { VersionTagSchema, type ProcessingCompatibility } from "@crawl-automation/v3-contracts";

/** Label images go out only over HTTPS, or over plain HTTP to an address on the private network. */
function isAllowedAddress(raw: string): boolean {
  const url = new URL(raw);
  if (url.protocol === "https:") {
    return true;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !ipaddr.isValid(host)) {
    return false;
  }
  return ["private", "loopback", "uniqueLocal"].includes(ipaddr.parse(host).range());
}

/** Settings of the OCR API client, read once at startup. */
export const OcrApiSettingsSchema = z.strictObject({
  /** The OCR API's base address, e.g. `https://192.0.2.20:8081` (documentation address). */
  baseUrl: z.url().refine(isAllowedAddress, "HTTPS, or HTTP to a private-network address"),
  provider: VersionTagSchema,
  timeoutMs: z.number().int().min(100).max(60_000).default(45_000),
  maxInputBytes: z.number().int().min(1).max(16_777_216).default(16_777_216),
  maxResponseBytes: z.number().int().min(1).max(8_388_608).default(8_388_608),
  /** Lines scored below this are dropped by the OCR API; its own default applies when unset. */
  minScore: z.number().min(0).max(1).optional(),
});
export type OcrApiSettings = z.output<typeof OcrApiSettingsSchema>;

/**
 * What an OCR task must name to be run by this client. The fingerprint covers only what shapes the output (provider,
 * endpoint path, score threshold, size limits), never the address, so one OCR queue serves every machine. It is the
 * same formula the previous client used, so existing tasks and results stay valid.
 */
export function ocrCompatibility(settings: OcrApiSettings): ProcessingCompatibility {
  const material = {
    provider: settings.provider,
    path: "/ocr",
    minScore: settings.minScore ?? null,
    maxInputBytes: settings.maxInputBytes,
    maxResponseBytes: settings.maxResponseBytes,
  };
  return {
    module: "ocr.file",
    schemaVersion: 1,
    implementationVersion: "multipart-ocr/2",
    policyVersion: "single-call/1",
    resultSchemaVersion: 2,
    configFingerprint: sha256(Buffer.from(JSON.stringify(material))),
  };
}
