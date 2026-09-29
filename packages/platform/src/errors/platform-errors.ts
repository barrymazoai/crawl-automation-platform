import { defineErrors } from "./define-errors.js";

/** Errors raised by the platform layer itself. */
export const platformErrors = defineErrors({
  "CONFIG.NOT_ABSOLUTE": { category: "RUNTIME", message: "Config path must be absolute." },
  "CONFIG.UNSAFE_FILE": {
    category: "RUNTIME",
    message: "Config must be a regular file readable only by its owner.",
  },
  "CONFIG.TOO_LARGE": { category: "RUNTIME", message: "Config file is larger than 4 MiB." },
  "CONFIG.INVALID": { category: "RUNTIME", message: "Config does not match its schema." },
  "DATABASE.UNAVAILABLE": { category: "RUNTIME", message: "Database is unavailable." },
  "HEALTH.PATH_NOT_ABSOLUTE": {
    category: "RUNTIME",
    message: "Health file path must be absolute.",
  },
  "TEMPORAL.UNAVAILABLE": { category: "RUNTIME", message: "Temporal is unavailable." },
});
