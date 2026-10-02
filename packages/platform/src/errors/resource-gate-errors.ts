import { defineErrors } from "./define-errors.js";

export const resourceGateCodes = {
  browserRouteInvalid: "RESOURCE.BROWSER_ROUTE_INVALID",
  browserPermitMismatch: "RESOURCE.BROWSER_PERMIT_MISMATCH",
  waitLimit: "RESOURCE.WAIT_LIMIT",
  identityConflict: "RESOURCE.IDENTITY_CONFLICT",
  releaseUnknown: "RESOURCE.RELEASE_UNKNOWN",
  ownerQuarantined: "RESOURCE.OWNER_QUARANTINED",
  reviewStopUnverified: "RESOURCE.REVIEW_STOP_UNVERIFIED",
  cleanupUnverified: "RESOURCE.CLEANUP_UNVERIFIED",
} as const;

/** Workflow-safe registry: this module and its imports contain no Node dependencies. */
export const resourceGateErrors = defineErrors({
  [resourceGateCodes.browserRouteInvalid]: {
    category: "SCHEDULER",
    message: "Browser work requires exactly one registered host browser resource and its queue.",
  },
  [resourceGateCodes.browserPermitMismatch]: {
    category: "SCHEDULER",
    message: "The held browser permit or its owner does not match this worker's browser resource.",
  },
  [resourceGateCodes.cleanupUnverified]: {
    category: "SCHEDULER",
    message: "Executor or task-page shutdown is unverified; the permit remains quarantined.",
  },
  [resourceGateCodes.waitLimit]: {
    category: "SCHEDULER",
    message: "Resource wait limit reached; business execution did not start.",
  },
  [resourceGateCodes.identityConflict]: {
    category: "SCHEDULER",
    message: "The resource decision does not match the requested permit.",
  },
  [resourceGateCodes.releaseUnknown]: {
    category: "SCHEDULER",
    message: "The resource release could not be verified.",
  },
  [resourceGateCodes.ownerQuarantined]: {
    category: "SCHEDULER",
    message: "Sibling execution requires recovery.",
  },
  [resourceGateCodes.reviewStopUnverified]: {
    category: "SCHEDULER",
    message: "Execution stop could not be verified.",
  },
});

export type ResourceGateErrorCode = keyof typeof resourceGateErrors.codes;
