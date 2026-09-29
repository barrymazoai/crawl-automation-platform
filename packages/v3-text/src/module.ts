// Moved to @crawl-automation/processing (text/step). The old workers keep the old dependency names.
import type { TextInput } from "@crawl-automation/v3-contracts";
import type { PrivateReviewReader, ReviewWriter } from "@crawl-automation/v3-review";
import { TextStep, textProtocolPrompt } from "@crawl-automation/processing";
import type { TextHandoff } from "./handoff.js";
import type { TextProvider } from "./ports.js";

export interface TextDependencies {
  provider: TextProvider;
  handoff: TextHandoff;
  reviews: ReviewWriter & PrivateReviewReader;
  nodeId: string;
  /** "register" (default) writes the ledger; "upload-only" is cloud mode (the receipt registers it). */
  mode?: "register" | "upload-only";
}

export function textPrompt(input: TextInput, fullText: string) {
  return textProtocolPrompt(input, fullText);
}

export class TextModule extends TextStep {
  constructor(deps: TextDependencies) {
    super({
      model: deps.provider,
      results: deps.handoff,
      reviews: deps.reviews,
      nodeId: deps.nodeId,
      ...(deps.mode ? { mode: deps.mode } : {}),
    });
  }
}
