import { dirname } from "node:path";
import { sha256 } from "@crawl-automation/platform";
import { z } from "zod";
import { captureFile, type CaptureFile } from "./archive.js";
import { dtcAgentErrors } from "./errors.js";

const MovedReceiptSchema = z.strictObject({
  codec: z.literal("ego-native-original/1"),
  kind: z.literal("html"),
  url: z.url(),
  capturedAt: z.iso.datetime(),
  path: z.string().regex(/^native-originals\/[a-f0-9]{64}\.html$/),
  byteSize: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  observation: z.strictObject({
    kind: z.literal("moved"),
    requestedUrl: z.url(),
    actualUrl: z.url(),
    targetId: z.string().min(1),
  }),
});

export interface MovedOriginal {
  status: "moved";
  requestedUrl: string;
  actualUrl: string;
  html: Uint8Array;
}

/** Read only archived task-owned receipts and their byte-verified original HTML. */
export async function readMovedOriginal(input: {
  root: string;
  evidenceFiles: CaptureFile[];
  requestedUrl: string;
}): Promise<MovedOriginal | null> {
  const root = dirname(input.root);
  for (const file of input.evidenceFiles) {
    if (!/^\.\.\/native-originals\/[^/]+\.receipt\.json$/.test(file.path)) {
      continue;
    }
    const receipt = await readMovedReceipt(root, file);
    if (!receipt || receipt.observation.requestedUrl !== input.requestedUrl) {
      continue;
    }
    const actualUrl = movedActualUrl(receipt, input.requestedUrl);
    const html = await readMovedHtml(root, input.evidenceFiles, receipt);
    return { status: "moved", requestedUrl: input.requestedUrl, actualUrl, html };
  }
  return null;
}

type MovedReceipt = z.infer<typeof MovedReceiptSchema>;

async function readMovedReceipt(root: string, file: CaptureFile): Promise<MovedReceipt | null> {
  const bytes = await captureFile(root, file.path.slice(3));
  if (bytes.length !== file.byteSize || sha256(bytes) !== file.sha256) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const parsed = MovedReceiptSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function movedActualUrl(receipt: MovedReceipt, requestedUrl: string): string {
  const requested = new URL(requestedUrl);
  const actual = new URL(receipt.observation.actualUrl);
  if (
    receipt.url !== actual.href ||
    requested.origin !== actual.origin ||
    requested.pathname.replace(/\/$/, "") === actual.pathname.replace(/\/$/, "")
  ) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
  }
  return actual.href;
}

async function readMovedHtml(root: string, files: CaptureFile[], receipt: MovedReceipt) {
  const original = files.find((entry) => entry.path === `../${receipt.path}`);
  if (!original || original.sha256 !== receipt.sha256 || original.byteSize !== receipt.byteSize) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
  }
  const html = await captureFile(root, receipt.path);
  if (html.length !== receipt.byteSize || sha256(html) !== receipt.sha256) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
  }
  return html;
}
