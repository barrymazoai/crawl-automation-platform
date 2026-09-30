import { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { R2Objects } from "./r2-objects.js";
import { R2ScopeSchema, type R2Scope } from "./r2-settings.js";

export function createR2Objects(
  raw: R2Scope,
  credentials: { accessKeyId: string; secretAccessKey: string },
) {
  const scope = R2ScopeSchema.parse(raw);
  const auth = z
    .strictObject({
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
    })
    .parse(credentials);
  const client = new S3Client({
    endpoint: scope.endpoint,
    region: "auto",
    credentials: auth,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    forcePathStyle: true,
  });
  return { store: new R2Objects(client, scope), close: () => client.destroy() };
}
