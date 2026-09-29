import { defineErrors } from "@crawl-automation/platform";

/** Errors about channels themselves: which exist, and how they may be captured. */
export const channelErrors = defineErrors({
  "CHANNEL.UNKNOWN": {
    category: "VALIDATION",
    message: "No adapter is registered for this channel.",
  },
  "CHANNEL.DUPLICATE": { category: "RUNTIME", message: "Two adapters claim the same channel." },
  "CHANNEL.CAPTURE_MODE_UNSUPPORTED": {
    category: "RUNTIME",
    message: "This channel cannot be captured in the configured mode.",
  },
  "CHANNEL.CAPTURE_LANE_MISMATCH": {
    category: "RUNTIME",
    message:
      "The capture permit is the wrong kind for the capture mode (e.g. a browser permit for HTTP).",
  },
  "CAPTURE.DOWNLOAD_UNRESOLVED": {
    category: "SOURCE",
    message: "A download for this page was already begun and never confirmed; it is not repeated.",
  },
  "CAPTURE.REDIRECT_UNVERIFIED": {
    category: "SOURCE",
    message: "The page answered with a redirect.",
  },
  "CAPTURE.ACCESS_CHALLENGE": {
    category: "SOURCE",
    message: "The site answered with a bot challenge.",
  },
  "CAPTURE.NOT_FOUND": { category: "SOURCE", message: "The page no longer exists." },
  "CAPTURE.HTTP_STATUS": {
    category: "SOURCE",
    message: "The page answered with an unexpected status.",
  },
  "CAPTURE.NOT_HTML": { category: "SOURCE", message: "The page is not HTML." },
  "CAPTURE.ENCODING": { category: "SOURCE", message: "The page is compressed or not valid UTF-8." },
  "CAPTURE.PAGE_LIMIT": {
    category: "SOURCE",
    message: "The page is larger than the channel allows.",
  },
  "CAPTURE.PAGE_NOT_DELIVERED": { category: "SOURCE", message: "The page body was empty." },
  "CAPTURE.ARCHIVE_IDENTITY": {
    category: "ARTIFACT",
    message: "The archived page belongs to a different capture.",
  },
  "CAPTURE.ARCHIVE_MISSING": {
    category: "ARTIFACT",
    message: "The archive receipt exists but the page bytes do not.",
  },
  "CAPTURE.ARCHIVE_CONFLICT": {
    category: "ARTIFACT",
    message: "A different page is already archived for this capture.",
  },
  "CAPTURE.ARCHIVE_UNVERIFIED": {
    category: "ARTIFACT",
    message: "The archived page could not be read back.",
  },
});
