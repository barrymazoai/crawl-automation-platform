import { ApplicationFailure } from "@temporalio/workflow";

/** A label source that is not the one this product's plan named: never retried. */
export const identityConflict = () =>
  ApplicationFailure.nonRetryable(
    "Label source identity conflict",
    "CHANNEL.LABEL_IDENTITY_CONFLICT",
  );
