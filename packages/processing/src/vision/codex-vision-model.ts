import { z } from "zod";
import { verifyBytes } from "@crawl-automation/platform";
import {
  ImageEvidenceSchema,
  labelExtractionVersion,
  labelValidationVersion,
  type ArtifactRef,
} from "@crawl-automation/v3-contracts";
import type { CodexConnectionFactory } from "@crawl-automation/platform";
import { CodexClient } from "../codex/codex-client.js";
import { asVisionCodexError } from "../codex/codex-errors.js";
import type { CodexModelProfile } from "../codex/codex-profile.js";
import { CodexClientSettingsSchema } from "../codex/codex-settings.js";
import { hashString } from "../results/result-record.js";
import {
  labelVisionPolicyVersion,
  labelVisionOutputSchema,
  labelVisionPrompt,
} from "./protocol/label-vision.js";
import { labelVisionOutputV2Schema, labelVisionPromptV2 } from "./protocol/label-vision-v2.js";
import {
  visionOutputSchema,
  visionPrompt,
  visionValidationVersion,
} from "./protocol/legacy-vision.js";
import { visionRequest, type VisionProtocol } from "./protocol/vision-protocol.js";
import { visionFailure } from "./vision-errors.js";

export const CodexVisionConfigSchema = CodexClientSettingsSchema.extend({
  extractionProtocol: z.enum(["label-extraction/1", "label-extraction/2"]).optional(),
});
export type CodexVisionConfig = z.infer<typeof CodexVisionConfigSchema>;

/** The largest image sent to the model, in bytes. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Vision names Codex failures `VISION.*`, as the previous vision client did. */
const visionProfile: CodexModelProfile = {
  workspace: "vision-",
  modalities: ["text", "image"],
  renameError: asVisionCodexError,
  privateConfig: () => visionFailure("VISION.PRIVATE_CONFIG", "not_executed"),
  closed: () => visionFailure("VISION.CODEX_CLOSED", "not_executed"),
};

/** The vision model a task is pinned to: its answer format and its setup's fingerprint. */
export interface VisionModel {
  readonly fingerprint: string;
  readonly extractionProtocol: VisionProtocol;
  interpret(image: ArtifactRef, bytes: Uint8Array, signal: AbortSignal): Promise<string>;
}

/**
 * The fingerprint of a vision setup. It covers the model settings, the prompt and the answer format, so any change is
 * a new setup that old tasks do not match. The same formulas the previous vision client used.
 */
function visionFingerprint(config: CodexVisionConfig): string {
  const { settings, runtimeProfileVersion, timeoutMs, extractionProtocol } = config;
  const common = [settings, runtimeProfileVersion, timeoutMs, "original"];
  if (extractionProtocol === "label-extraction/2") {
    const quality = "label-visual-quality/1";
    return hashString(
      JSON.stringify([
        "codex-vision/3",
        ...common,
        extractionProtocol,
        quality,
        labelVisionPromptV2,
        labelVisionOutputV2Schema,
      ]),
    );
  }
  if (extractionProtocol) {
    const versions = [labelExtractionVersion, labelVisionPolicyVersion, labelValidationVersion];
    return hashString(
      JSON.stringify([
        "codex-vision/2",
        ...common,
        ...versions,
        labelVisionPrompt,
        labelVisionOutputSchema,
      ]),
    );
  }
  return hashString(
    JSON.stringify([
      "codex-vision/1",
      ...common,
      visionPrompt,
      visionOutputSchema,
      visionValidationVersion,
    ]),
  );
}

/** The vision model through Codex: the original image and the protocol's prompt, one call per task. */
export class CodexVisionModel implements VisionModel {
  readonly fingerprint: string;
  readonly extractionProtocol: VisionProtocol;

  private constructor(
    config: CodexVisionConfig,
    private readonly client: CodexClient | null,
  ) {
    this.fingerprint = visionFingerprint(config);
    this.extractionProtocol = config.extractionProtocol;
  }

  /** The fingerprint and protocol a config would have, without opening anything. */
  static describe(raw: unknown) {
    const model = new CodexVisionModel(CodexVisionConfigSchema.parse(raw), null);
    return { configFingerprint: model.fingerprint, extractionProtocol: model.extractionProtocol };
  }

  static async open(
    raw: unknown,
    environment: NodeJS.ProcessEnv,
    connect?: CodexConnectionFactory,
  ) {
    const parsed = CodexVisionConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw visionProfile.privateConfig();
    }
    const settings: Partial<CodexVisionConfig> = { ...parsed.data };
    delete settings.extractionProtocol;
    const client = await CodexClient.open(settings, {
      environment,
      profile: visionProfile,
      ...(connect ? { connect } : {}),
    });
    return new CodexVisionModel(parsed.data, client);
  }

  /**
   * Startup capability check only (the model must accept images): no thread, no model turn. Its failures keep Codex's
   * own `TEXT.CODEX_*` codes, as the previous vision client's did.
   */
  async check(signal: AbortSignal): Promise<void> {
    await this.opened().check(signal);
  }

  async interpret(rawImage: ArtifactRef, bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    const image = ImageEvidenceSchema.parse(rawImage);
    verifyBytes(image, bytes, MAX_IMAGE_BYTES);
    const name = `source.${EXTENSIONS[image.mediaType] ?? "bin"}`;
    const call = { ...visionRequest(this.extractionProtocol), image: { name, bytes } };
    return this.opened().run(call, signal);
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  private opened(): CodexClient {
    if (!this.client) {
      throw visionProfile.closed();
    }
    return this.client;
  }
}
