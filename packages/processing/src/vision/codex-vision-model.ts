import { verifyBytes } from "@crawl-automation/platform";
import { ImageEvidenceSchema, type ArtifactRef } from "@crawl-automation/v3-contracts";
import type { CodexConnectionFactory } from "@crawl-automation/platform";
import { CodexClient } from "../codex/codex-client.js";
import { asVisionCodexError } from "../codex/codex-errors.js";
import type { CodexModelProfile } from "../codex/codex-profile.js";
import { visionRequest, type VisionProtocol } from "./protocol/vision-protocol.js";
import { visionFingerprint } from "./vision-fingerprint.js";
import { visionFailure } from "./vision-errors.js";
import {
  labelIngredientPresencePrompt,
  labelIngredientPresenceOutputSchema,
  retainIngredientPresenceAnswer,
} from "./protocol/label-ingredient-presence.js";

import { CodexVisionConfigSchema, type CodexVisionConfig } from "./codex-vision-config.js";
export { CodexVisionConfigSchema, type CodexVisionConfig };

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

/** The vision model through Codex: the original image and the protocol's prompt, one call per task. */
export class CodexVisionModel implements VisionModel {
  readonly fingerprint: string;
  readonly extractionProtocol: VisionProtocol;

  private constructor(
    private readonly config: CodexVisionConfig,
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
    delete settings.visualProtocol;
    delete settings.ingredientPresencePolicy;
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
    const request = this.config.visualProtocol
      ? { prompt: labelIngredientPresencePrompt, outputSchema: labelIngredientPresenceOutputSchema }
      : visionRequest(this.extractionProtocol);
    const raw = await this.opened().run({ ...request, image: { name, bytes } }, signal);
    return this.config.visualProtocol
      ? retainIngredientPresenceAnswer(raw, this.config.ingredientPresencePolicy)
      : raw;
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
