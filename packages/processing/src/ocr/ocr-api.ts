import createClient, { type Client } from "openapi-fetch";
import { verifyBytes } from "@crawl-automation/platform";
import {
  OcrResponseSchema,
  type OcrInput,
  type OcrResponse,
  type ProcessingCompatibility,
} from "@crawl-automation/v3-contracts";
import type { paths } from "./api/ocr-api.generated.js";
import { ocrFailure } from "./ocr-errors.js";
import { ocrCompatibility, type OcrApiSettings } from "./ocr-api-settings.js";

type OcrFile = OcrInput["file"];

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

  /** `transport.fetch` replaces the global fetch, e.g. with a recorded answer in tests. */
  constructor(
    private readonly settings: OcrApiSettings,
    transport: { fetch?: (request: Request) => Promise<Response> } = {},
  ) {
    this.provider = settings.provider;
    this.supported = ocrCompatibility(settings);
    this.client = createClient<paths>({ baseUrl: settings.baseUrl, ...transport });
  }

  /** One call for one image. Nothing is sent unless the bytes are exactly the image's reference. */
  async recognize(file: OcrFile, bytes: Uint8Array, signal: AbortSignal): Promise<OcrResponse> {
    this.assertSendable(file, bytes);
    const answer = await this.post(file, bytes, signal);
    if (answer.status === 429) {
      throw ocrFailure("OCR.RATE_LIMIT");
    }
    if (answer.status !== 200) {
      throw ocrFailure("OCR.HTTP_STATUS");
    }
    if (!/^application\/json(?:\s*;|$)/i.test(answer.contentType)) {
      throw ocrFailure("OCR.PROTOCOL");
    }
    return this.read(answer.body);
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

  private async post(file: OcrFile, bytes: Uint8Array, signal: AbortSignal) {
    const timeout = AbortSignal.timeout(this.settings.timeoutMs);
    const minScore = this.settings.minScore;
    try {
      const { data, response } = await this.client.POST("/ocr", {
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

  /** The answer as the OCR API sent it, provider fields included; empty text is not a usable answer. */
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
    if (!parsed.text.trim()) {
      throw ocrFailure("OCR.EMPTY", "executed");
    }
    return parsed;
  }
}

function formWith(file: Blob, fileName: string): FormData {
  const form = new FormData();
  form.append("file", file, fileName);
  return form;
}
