import {
  GetObjectCommand,
  PutObjectCommand,
  type GetObjectCommandOutput,
  type PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { ObjectKeySchema } from "@crawl-automation/v3-contracts";
import { AppError } from "../errors/app-error.js";
import { artifactErrors } from "./artifact-errors.js";
import type { ObjectStore } from "./object-store.js";
import { readR2Body } from "./r2-body.js";
import { r2Diagnostics, r2Status } from "./r2-diagnostics.js";
import { R2ScopeSchema, type R2Scope } from "./r2-settings.js";

export interface R2ClientPort {
  send(
    command: GetObjectCommand,
    options: { abortSignal: AbortSignal },
  ): Promise<GetObjectCommandOutput>;
  send(
    command: PutObjectCommand,
    options: { abortSignal: AbortSignal },
  ): Promise<PutObjectCommandOutput>;
}

/** Fresh SigV4 request per read; no persisted presigned URLs or implicit retry. */
export class R2Objects implements ObjectStore {
  private readonly scope: R2Scope;

  constructor(
    private readonly client: R2ClientPort,
    scope: R2Scope,
  ) {
    this.scope = R2ScopeSchema.parse(scope);
  }

  private key(key: string) {
    return ObjectKeySchema.parse(`${this.scope.prefix}/${ObjectKeySchema.parse(key)}`);
  }

  private signal(signal: AbortSignal) {
    return AbortSignal.any([signal, AbortSignal.timeout(this.scope.timeoutMs)]);
  }

  async read(key: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw artifactErrors.create("ARTIFACT.TOO_LARGE");
    }
    try {
      return await this.readOnce(key, maxBytes, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AppError) {
        throw error;
      }
      if (r2Status(error) === 404 && error instanceof Error && error.name === "NoSuchKey") {
        return null;
      }
      // No cause: the SDK error carries request headers (credentials). r2Diagnostics keeps the safe reason.
      throw artifactErrors.create("ARTIFACT.UNAVAILABLE", { details: r2Diagnostics(error) });
    }
  }

  private async readOnce(key: string, maxBytes: number, signal: AbortSignal) {
    const scopedKey = this.key(key);
    const bounded = this.signal(signal);
    bounded.throwIfAborted();
    const command = new GetObjectCommand({ Bucket: this.scope.bucket, Key: scopedKey });
    const response = await this.client.send(command, { abortSignal: bounded });
    return readR2Body(response, maxBytes, bounded);
  }

  // ObjectStore's existing four-argument API is shared with legacy workers.
  // eslint-disable-next-line max-params
  async create(
    key: string,
    bytes: Uint8Array,
    mediaType: string,
    signal: AbortSignal,
  ): Promise<"created" | "exists"> {
    try {
      return await this.createOnce({ key, bytes, mediaType }, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AppError) {
        throw error;
      }
      // No cause: the SDK error carries request headers (credentials). r2Diagnostics keeps the safe reason.
      throw artifactErrors.create("ARTIFACT.UPLOAD_UNKNOWN", { details: r2Diagnostics(error) });
    }
  }

  private async createOnce(
    input: { key: string; bytes: Uint8Array; mediaType: string },
    signal: AbortSignal,
  ): Promise<"created" | "exists"> {
    const scopedKey = this.key(input.key);
    const bounded = this.signal(signal);
    bounded.throwIfAborted();
    const command = new PutObjectCommand({
      Bucket: this.scope.bucket,
      Key: scopedKey,
      Body: input.bytes,
      ContentLength: input.bytes.byteLength,
      ContentType: input.mediaType,
      IfNoneMatch: "*",
    });
    try {
      await this.client.send(command, { abortSignal: bounded });
      return "created";
    } catch (error) {
      signal.throwIfAborted();
      if (r2Status(error) === 412) {
        return "exists";
      }
      throw error;
    }
  }
}
