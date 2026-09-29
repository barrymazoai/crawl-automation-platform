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
});
