import { OcrApi, OcrHttpJobControl, type OcrApiSettings } from "@crawl-automation/processing";

/** OCR and its exact-job controls must use the same endpoint and HTTP transport. */
export function ocrClient(
  settings: OcrApiSettings,
  fetch: (request: Request) => Promise<Response> = globalThis.fetch,
) {
  const jobControl = settings.jobControl
    ? new OcrHttpJobControl({ baseUrl: settings.baseUrl, fetch })
    : undefined;
  return new OcrApi(settings, { fetch, ...(jobControl ? { jobControl } : {}) });
}
