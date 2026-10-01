// Expose the core port to repositories through the application's existing dependency boundary.
export {
  HTML_REUSE_WINDOW_MS,
  HtmlCaptureRequestSchema,
  SavedHtmlOriginalSchema,
  htmlCaptureErrors,
  type HtmlCaptureRequest,
  type SavedHtmlOriginal,
  type HtmlCaptureRecords,
  type HtmlCaptureAdmission,
} from "@crawl-automation/channels-core";
