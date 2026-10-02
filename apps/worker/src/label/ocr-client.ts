import { OcrApi, OcrHttpJobControl, type OcrApiSettings } from "@crawl-automation/processing";

interface OcrTransports {
  fetch?: (request: Request) => Promise<Response>;
  jobControlFetch?: (request: Request) => Promise<Response>;
}

/** Same configured endpoint; stop queries use an independent, fresh control connection. */
export function ocrClient(
  settings: OcrApiSettings,
  transport: OcrTransports = {},
  verifiedFailures = true,
) {
  const jobControl = settings.jobControl
    ? new OcrHttpJobControl({
        baseUrl: settings.baseUrl,
        ...(transport.jobControlFetch ? { fetch: transport.jobControlFetch } : {}),
      })
    : undefined;
  return new OcrApi(settings, {
    ...(transport.fetch ? { fetch: transport.fetch } : {}),
    verifiedFailures,
    ...(jobControl ? { jobControl } : {}),
  });
}
