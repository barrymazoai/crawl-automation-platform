import { S3Client } from "@aws-sdk/client-s3";

export function createInspectionClient(scope, credentials, requestHandler) {
  // S3Client's credential middleware annotates the supplied object with $source.
  // A separate copy keeps our strict factory's configuration immutable.
  return new S3Client({endpoint:scope.endpoint,region:"auto",credentials:{...credentials},
    forcePathStyle:true,maxAttempts:1,...(requestHandler ? {requestHandler} : {})});
}

export function mayContinueWithoutRetention(mode, error) {
  return mode === "--objects-only" && error?.name === "AccessDenied" && error?.$metadata?.httpStatusCode === 403;
}
