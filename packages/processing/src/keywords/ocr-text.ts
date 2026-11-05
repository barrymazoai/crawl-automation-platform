import { isDeepStrictEqual } from "node:util";
import type { ObjectStore } from "@crawl-automation/platform";
import type { ArtifactResolver } from "@crawl-automation/platform";
import {
  OcrIntentSchema,
  OcrRegistrationSchema,
  observationIdentity,
  type KeywordPolicy,
  type KeywordResult,
  type OcrInput,
  type OcrRegistration,
} from "@crawl-automation/v3-contracts";
import type { ResultFacts, ResultRegistry } from "../results/result-kind.js";
import { decodeJson } from "../results/result-record.js";
import { ocrKeys, ocrLimits, ocrResultKind } from "../ocr/ocr-kind.js";
import { keywordFailure } from "./keyword-errors.js";
import { screenKeywords, verifySelection } from "./keyword-screen.js";

type OcrFacts = ResultFacts<OcrRegistration>;

/** One printed line as the OCR read it, with its four corners when the provider gave them. */
export interface OcrLine {
  text: string;
  polygon?: [number, number][];
}
/** A verified OCR result: its text and, for results that keep the provider's answer, its lines. */
export interface OcrReading {
  text: string;
  lines: OcrLine[];
}

/** The reading of a registration whose result files were verified; read from a local copy or R2. */
async function registeredReading(
  artifacts: Pick<ArtifactResolver, "resolve">,
  registration: OcrRegistration,
  signal: AbortSignal,
): Promise<OcrReading> {
  const owner = observationIdentity(registration.input);
  const resolved = await artifacts.resolve(registration.result, owner, signal);
  const output = ocrResultKind.parseOutput(registration.input, decodeJson(resolved.bytes));
  const lines = "rawResponse" in output ? output.rawResponse.lines : [];
  return {
    text: output.text,
    lines: lines.map((line) => ({
      text: line.text,
      ...(line.polygon ? { polygon: line.polygon } : {}),
    })),
  };
}

async function registeredText(
  artifacts: Pick<ArtifactResolver, "resolve">,
  registration: OcrRegistration,
  signal: AbortSignal,
): Promise<string> {
  return (await registeredReading(artifacts, registration, signal)).text;
}

/** The selection names exactly this OCR operation, image and observation. */
function assertSameSource(registration: OcrRegistration, selection: KeywordResult): void {
  const same =
    registration.input.operationId === selection.ocrOperationId &&
    isDeepStrictEqual(observationIdentity(registration.input), selection.observation) &&
    isDeepStrictEqual(registration.input.file, selection.image);
  if (!same) {
    throw keywordFailure("SCREEN.SOURCE_CONFLICT");
  }
}

/** OCR text from the ledger: only a registered, durable OCR result, never a file path or a caller's text. */
export class LedgerOcrText {
  constructor(
    private readonly deps: {
      artifacts: Pick<ArtifactResolver, "resolve">;
      results: { inspect(input: OcrInput, signal: AbortSignal): Promise<OcrFacts> };
      registry: Pick<ResultRegistry<OcrRegistration>, "read">;
    },
  ) {}

  /** Screens the text of one registered OCR result for label keywords (the US policy unless another is given). */
  async screen(raw: unknown, signal: AbortSignal, policy?: KeywordPolicy): Promise<KeywordResult> {
    const registration = await this.verified(raw, signal);
    const text = await registeredText(this.deps.artifacts, registration, signal);
    const { input } = registration;
    const observation = observationIdentity(input);
    return screenKeywords(
      {
        observation,
        image: input.file,
        ocrOperationId: input.operationId,
        text,
      },
      policy,
    );
  }

  /** The OCR text behind a keyword selection, after recomputing the selection from it. */
  async verifiedText(selection: KeywordResult, signal: AbortSignal): Promise<string> {
    return (await this.verifiedOcr(selection, signal)).text;
  }

  /** The same verified OCR result, with its printed lines' positions. */
  async verifiedOcr(selection: KeywordResult, signal: AbortSignal): Promise<OcrReading> {
    const saved = await this.deps.registry.read(selection.ocrOperationId);
    if (!saved) {
      throw keywordFailure("SCREEN.UPSTREAM_UNVERIFIED");
    }
    const registration = await this.verified(saved, signal);
    assertSameSource(registration, selection);
    const reading = await registeredReading(this.deps.artifacts, registration, signal);
    verifySelection(selection, reading.text);
    return reading;
  }

  private async verified(raw: unknown, signal: AbortSignal): Promise<OcrRegistration> {
    const registration = OcrRegistrationSchema.parse(raw);
    const facts = await this.deps.results.inspect(registration.input, signal);
    const same = isDeepStrictEqual(facts.record, registration);
    if (!facts.resultRegistered || !facts.artifactDurable || !same) {
      throw keywordFailure("SCREEN.UPSTREAM_UNVERIFIED");
    }
    return registration;
  }
}

/**
 * Cloud mode: OCR text for a worker without a ledger, from R2 alone. The OCR task is recovered from its intent, the
 * result is rebuilt and checked byte for byte, and the selection (which came from the Mini) is recomputed from it.
 */
export class RemoteOcrText {
  constructor(
    private readonly deps: {
      artifacts: Pick<ArtifactResolver, "resolve">;
      results: { inspectRemote(input: OcrInput, signal: AbortSignal): Promise<OcrFacts> };
      remote: Pick<ObjectStore, "read">;
    },
  ) {}

  async verifiedText(selection: KeywordResult, signal: AbortSignal): Promise<string> {
    return (await this.verifiedOcr(selection, signal)).text;
  }

  async verifiedOcr(selection: KeywordResult, signal: AbortSignal): Promise<OcrReading> {
    const input = await this.intendedInput(selection.ocrOperationId, signal);
    const facts = await this.deps.results.inspectRemote(input, signal);
    if (!facts.artifactDurable || !facts.record) {
      throw keywordFailure("SCREEN.UPSTREAM_UNVERIFIED");
    }
    assertSameSource(facts.record, selection);
    const reading = await registeredReading(this.deps.artifacts, facts.record, signal);
    verifySelection(selection, reading.text);
    return reading;
  }

  private async intendedInput(operationId: string, signal: AbortSignal): Promise<OcrInput> {
    const key = ocrKeys.intent({ operationId });
    const bytes = await this.deps.remote.read(key, ocrLimits.intentBytes, signal);
    if (!bytes) {
      throw keywordFailure("SCREEN.UPSTREAM_UNVERIFIED");
    }
    try {
      return OcrIntentSchema.parse(decodeJson(bytes)).input;
    } catch (error) {
      throw keywordFailure("SCREEN.UPSTREAM_UNVERIFIED", error);
    }
  }
}
