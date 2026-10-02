import { z } from "zod";
import { sha256, type RetainedPublication } from "@crawl-automation/platform";
import type { Address, FileTransport, Response } from "@crawl-automation/channels-core";
import { CaptureFileSchema } from "./archive.js";
import { dtcAgentErrors } from "./errors.js";

const Manifest = z.object({
  version: z.literal("dtc-agent-images/1"),
  url: z.url(),
  images: z
    .array(CaptureFileSchema.extend({ url: z.url() }))
    .min(1)
    .max(100),
});

/** Downstream consumes capture's byte-exact original; it never downloads the image a second time. */
export class DtcAgentFileTransport implements FileTransport {
  readonly targetResolution = "browser" as const;
  constructor(
    private readonly publication: RetainedPublication,
    private readonly capture: {
      operationId: string;
      url: string;
      egressId: string;
    },
  ) {}

  get egressId() {
    return this.capture.egressId;
  }

  // eslint-disable-next-line max-params -- FileTransport contract.
  async get(
    url: URL,
    address: Address | undefined,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<Response> {
    if (address !== undefined || Object.keys(headers).length) {
      throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
    }
    const raw = await this.publication.remote.read(
      `v3/dtc-agent/${this.capture.operationId}/images.json`,
      1_000_000,
      signal,
    );
    const manifest = Manifest.parse(raw ? JSON.parse(Buffer.from(raw).toString()) : null);
    const image = manifest.images.find((entry) => entry.url === url.href);
    if (manifest.url !== this.capture.url || !image) {
      throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
    }
    const body = await this.publication.remote.read(image.objectKey, image.byteSize, signal);
    if (!body || body.length !== image.byteSize || sha256(body) !== image.sha256) {
      throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
    }
    let closed = false;
    return {
      status: 200,
      headers: { "content-type": image.mediaType, "content-length": String(image.byteSize) },
      body: (async function* () {
        signal.throwIfAborted();
        if (!closed) {
          yield body;
        }
      })(),
      close() {
        closed = true;
      },
    };
  }
}
