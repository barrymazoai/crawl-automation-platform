import { isDeepStrictEqual } from "node:util";
import {
  AcquireFileModule,
  systemDns,
  type FileEvidence,
  type FileTransport,
  type SourceAccess,
} from "../files/index.js";
import {
  observationIdentity,
  type ChannelPlanInput,
  type FileAcquireInput,
  type FileAcquireOutcome,
} from "@crawl-automation/v3-contracts";
import type { ChannelId } from "../adapter.js";
import { channelErrors } from "../errors.js";
import type { ChannelRegistry } from "../registry.js";
import type { ProductPlans } from "../planning/product-plans.js";

export interface ProductFilesDeps {
  registry: ChannelRegistry;
  plans: Pick<ProductPlans, "fileSource">;
  files: FileEvidence;
  /** A direct HTTPS GET of the image; images are public and need no browser or provider. */
  transport: FileTransport;
  transportFor?: (request: FileRequest) => FileTransport;
}

export interface FileRequest {
  channel: ChannelId;
  sourcePlan: ChannelPlanInput;
  acquire: FileAcquireInput;
}

/**
 * Downloads one product image the formula plan names, keeps the original, and returns its receipt. The image URL
 * comes only from the durable plan, never from the request.
 */
export class ProductFiles {
  constructor(private readonly deps: ProductFilesDeps) {}

  async acquire(request: FileRequest, signal: AbortSignal): Promise<FileAcquireOutcome> {
    const url = await this.deps.plans.fileSource(request.sourcePlan, request.acquire, signal);
    const adapter = this.deps.registry.get(request.channel);
    const origins = adapter.fileOrigins ?? adapter.httpPolicy?.origins ?? [];
    const access = this.access({
      expected: request.acquire,
      url,
      origins,
      transport: this.deps.transportFor?.(request) ?? this.deps.transport,
    });
    return new AcquireFileModule(this.deps.files, { access, dns: systemDns }).run(
      request.acquire,
      signal,
    );
  }

  private access(target: {
    expected: FileAcquireInput;
    url: string;
    origins: readonly string[];
    transport: FileTransport;
  }): SourceAccess {
    const transport = target.transport;
    return {
      acquire: async (input) => {
        if (!isDeepStrictEqual(input, target.expected)) {
          throw channelErrors.create("CAPTURE.FILE_REQUEST_MISMATCH");
        }
        let released = false;
        return {
          owner: observationIdentity(input),
          sourceId: input.sourceId,
          resourceId: input.resourceId,
          binding: input.binding,
          url: target.url,
          allowedOrigins: [...target.origins],
          transport,
          headersFor: () => ({}),
          assertActive: () => {
            if (released) {
              throw channelErrors.create("CAPTURE.FILE_SESSION_ENDED");
            }
          },
          release: async () => {
            released = true;
          },
        };
      },
    };
  }
}
