import { defineErrors } from "../errors/define-errors.js";

export const storageErrors = defineErrors({
  "STORAGE.LOCAL_CONFIG": {
    category: "RUNTIME",
    message: "The local evidence folder is not a private folder of this process.",
  },
  "STORAGE.TOO_LARGE": {
    category: "ARTIFACT",
    message: "The object is larger than allowed.",
  },
  "STORAGE.INVALID_LIMIT": {
    category: "VALIDATION",
    message: "The requested size limit is not a positive whole number within the store's limit.",
  },
  "STORAGE.INVALID_KEY": {
    category: "VALIDATION",
    message: "The object key is not a safe relative path.",
  },
});
