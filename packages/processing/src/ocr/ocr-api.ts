import { randomUUID } from "node:crypto";
import createClient, { type Client } from "openapi-fetch";
import {
  provePermitExecutionStopped,
  recordPermitExecution,
  verifyBytes,
} from "@crawl-automation/platform";
import {
  OcrResponseSchema,
  type OcrInput,
  type OcrResponse,
  type ProcessingCompatibility,
} from "@crawl-automation/v3-contracts";
import type { paths } from "./api/ocr-api.generated.js";
import { ocrFailure } from "./ocr-errors.js";
import { verifiedOcrFailure } from "./ocr-verified-failure.js";
import { ocrCompatibility, type OcrApiSettings } from "./ocr-api-settings.js";
import {
  verifyOcrStop,
  type OcrExecutionIdentity,
  type OcrJobControl,
  type OcrStopResult,
} from "./ocr-stop.js";
export type { OcrExecutionIdentity, OcrJobControl, OcrStopResult } from "./ocr-stop.js";

type OcrFile = OcrInput["file"];
interface OcrTransport {
  fetch?: (request: Request) => Promise<Response>;
  jobControl?: OcrJobControl;
  /** False only for OCR activities scheduled before ocr-verified-failure-v1. */
  verifiedFailures?: boolean;
}

const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Our OCR API (FastAPI on the Windows machine), called through a client generated from its OpenAPI document. Only
 * the meaning of its answers is ours: which ones are usable, and which failure code each other one is.
 */
export class OcrApi {
  readonly provider: string;
  readonly supported: ProcessingCompatibility;
  private readonly client: Client<paths>;
  private readonly jobControl: OcrJobControl | undefined;
  private readonly verifiedFailures: boolean;

  /** `transport.fetch` replaces the global fetch, e.g. with a recorded answer in tests. */
  constructor(
    private readonly settings: OcrApiSettings,
    transport: OcrTransport = {},
  ) {
    this.provider = settings.provider;
    this.supported = ocrCompatibility(settings);
    const { jobControl, verifiedFailures = true, ...clientTransport } = transport;
    this.jobControl = jobControl;
    this.verifiedFailures = verifiedFailures;
    this.client = createClient<paths>({ baseUrl: settings.baseUrl, ...clientTransport });
  }

  /** One call for one image. Nothing is sent unless the bytes are exactly the image's reference. */
  async recognize(file: OcrFile, bytes: Uint8Array, signal: AbortSignal): Promise<OcrResponse> {
    this.assertSendable(file, bytes);
    if (signal.aborted) {
      throw ocrFailure("OCR.CANCELLED", "not_executed", signal.reason);
    }
    const identity: OcrExecutionIdentity = {
      kind: "ocr",
      executionId: randomUUID(),
      endpoint: this.settings.baseUrl,
      metadata: { jobControlSupported: this.jobControl !== undefined },
    };
    await recordPermitExecution(identity);
    try {
      const answer = await this.post(file, bytes, { signal, identity });
      const output = this.readAnswer(answer);
      await provePermitExecutionStopped(identity, {
        kind: "ocr-synchronous-response",
        observedAt: new Date().toISOString(),
      });
      return output;
    } catch (error) {
      const cleanup = await this.stopAndVerify(identity);
      throw verifiedOcrFailure(error, cleanup, this.verifiedFailures);
    }
  }

  private readAnswer(answer: { status: number; contentType: string; body: string }): OcrResponse {
    if (answer.status !== 200) {
      throw ocrFailure(answer.status === 429 ? "OCR.RATE_LIMIT" : "OCR.HTTP_STATUS");
    }
    if (!/^application\/json(?:\s*;|$)/i.test(answer.contentType)) {
      throw ocrFailure("OCR.PROTOCOL");
    }
    return this.read(answer.body);
  }

  /** A cancel receipt alone is insufficient; only a terminal query result proves shutdown. */
  async stopAndVerify(identity: OcrExecutionIdentity): Promise<OcrStopResult> {
    return verifyOcrStop({ identity, control: this.jobControl, settings: this.settings });
  }

  private assertSendable(file: OcrFile, bytes: Uint8Array): void {
    if (!extensions[file.mediaType] || !["source-image", "pdf-page"].includes(file.kind)) {
      throw ocrFailure("OCR.INVALID_INPUT", "not_executed");
    }
    if (bytes.byteLength > this.settings.maxInputBytes) {
      throw ocrFailure("OCR.INPUT_LIMIT", "not_executed");
    }
    try {
      verifyBytes(file, bytes, this.settings.maxInputBytes);
    } catch (error) {
      throw ocrFailure("OCR.INPUT_INTEGRITY", "not_executed", error);
    }
  }

  private async post(
    file: OcrFile,
    bytes: Uint8Array,
    options: { signal: AbortSignal; identity: OcrExecutionIdentity },
  ) {
    const { signal, identity } = options;
    const timeout = AbortSignal.timeout(this.settings.timeoutMs);
    const minScore = this.settings.minScore;
    try {
      const { data, response } = await this.client.POST("/ocr", {
        headers: this.jobControl?.requestHeaders(identity.executionId) ?? {},
        params: { query: minScore === undefined ? {} : { min_score: minScore } },
        body: { file: new Blob([Buffer.from(bytes)], { type: file.mediaType }) },
        bodySerializer: (body) => formWith(body.file, `image.${extensions[file.mediaType]}`),
        parseAs: "text",
        signal: AbortSignal.any([signal, timeout]),
      });
      const contentType = response.headers.get("content-type") ?? "";
      return { status: response.status, contentType, body: data ?? "" };
    } catch (error) {
      if (signal.aborted) {
        throw ocrFailure("OCR.CANCELLED", "unknown", error);
      }
      const code = timeout.aborted ? "OCR.TIMEOUT" : "OCR.RESPONSE_UNKNOWN";
      throw ocrFailure(code, "unknown", error);
    }
  }

  /** Keep every successful answer, including no text, as provider evidence for source preparation. */
  private read(body: string): OcrResponse {
    if (Buffer.byteLength(body) > this.settings.maxResponseBytes) {
      throw ocrFailure("OCR.OUTPUT_LIMIT", "executed");
    }
    let parsed: OcrResponse;
    try {
      parsed = OcrResponseSchema.parse(JSON.parse(body));
    } catch (error) {
      throw ocrFailure("OCR.PROTOCOL", "executed", error);
    }
    return parsed;
  }
}

function formWith(file: Blob, fileName: string): FormData {
  const form = new FormData();
  form.append("file", file, fileName);
  return form;
}
