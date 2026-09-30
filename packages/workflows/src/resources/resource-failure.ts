import {
  resourceGateErrors,
  type ResourceGateErrorCode,
} from "@crawl-automation/platform/errors/resource-gate";
import { ApplicationFailure } from "@temporalio/workflow";

export function resourceFailure(code: ResourceGateErrorCode, details: unknown = null) {
  return ApplicationFailure.nonRetryable(resourceGateErrors.codes[code].message, code, details);
}
