import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, link, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CompletionSchema,
  OcrOutputSchema,
  ReviewSchema,
  type Completion,
  type OcrInput,
  type OcrOutput,
  type Review,
  type Verification,
} from "../contracts/index.js";
import { sha256, validateInput } from "../contracts/fingerprint.js";
import type { EvidencePort } from "../ports/evidence.js";
import { assertProcessingResultMatches, processingIdentity } from "@crawl-automation/v3-contracts";

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

/** P0 only: one local filesystem, NOT R2 or a cross-machine database. */
export class LocalEvidence implements EvidencePort {
  constructor(readonly root: string) {}

  private path(key: string): string {
    if (
      !/^(intents|results|completions|reviews)\/[a-zA-Z0-9_.-]+\.json$/.test(
        key,
      )
    )
      throw new Error("Invalid evidence key");
    return resolve(this.root, key);
  }

  private async load(key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.path(key));
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async putOnce(key: string, value: unknown): Promise<boolean> {
    const target = this.path(key),
      bytes = JSON.stringify(value);
    await mkdir(dirname(target), { recursive: true });
    const scratch = `${target}.${randomUUID()}.tmp`;
    const handle = await open(scratch, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      try {
        await link(scratch, target);
        return true;
      } catch (error) {
        if (hasCode(error, "EEXIST")) return false;
        throw error;
      }
    } finally {
      await handle.close();
      // Only our temporary staging file; never remove an intent, result or proof.
      await unlink(scratch);
    }
  }

  private async putImmutable(key: string, value: unknown): Promise<void> {
    if (!(await this.putOnce(key, value))) {
      const existing = await this.load(key);
      if (existing?.toString() !== JSON.stringify(value))
        throw new Error("INPUT.CONFLICT");
    }
  }

  async reserve(raw: OcrInput): Promise<boolean> {
    const input = validateInput(raw);
    if (
      (await this.load(`results/${input.operationId}.json`)) ||
      (await this.load(`completions/${input.operationId}.json`))
    )
      return false;
    // Non-expiring execution-intent fact, not a renewable task lease.
    // After a crash, an intent without complete proof NEVER permits re-submission.
    return this.putOnce(`intents/${input.operationId}.json`, input);
  }

  async complete(raw: OcrInput, rawOutput: OcrOutput): Promise<Completion> {
    const input = validateInput(raw),
      output = OcrOutputSchema.parse(rawOutput);
    assertProcessingResultMatches(input, output, "output");
    const intentBytes = await this.load(`intents/${input.operationId}.json`);
    if (!intentBytes) throw new Error("No execution intent");
    const intent = validateInput(JSON.parse(intentBytes.toString()));
    if (
      intent.inputFingerprint !== input.inputFingerprint ||
      output.inputFingerprint !== input.inputFingerprint ||
      output.operationId !== input.operationId ||
      output.observationId !== input.observationId
    )
      throw new Error("INPUT.CONFLICT");
    const resultKey = `results/${input.operationId}.json`;
    await this.putImmutable(resultKey, output);
    const result = Buffer.from(JSON.stringify(output));
    const completion = CompletionSchema.parse({
      ...processingIdentity(input),
      resultKey,
      resultSha256: sha256(result),
      resultByteSize: result.length,
      complete: true,
    });
    await this.putImmutable(
      `completions/${input.operationId}.json`,
      completion,
    );
    return completion;
  }

  async verify(raw: OcrInput): Promise<Verification> {
    const input = validateInput(raw);
    const unverified = (
      code: Extract<Verification, { status: "unverified" }>["code"],
    ): Verification => ({ status: "unverified", code });
    try {
      const intentBytes = await this.load(`intents/${input.operationId}.json`);
      if (!intentBytes) return unverified("EXECUTION.OUTCOME_UNKNOWN");
      const intent = validateInput(JSON.parse(intentBytes.toString()));
      if (intent.inputFingerprint !== input.inputFingerprint)
        return unverified("INPUT.CONFLICT");
      const bytes = await this.load(`completions/${input.operationId}.json`);
      if (!bytes) return unverified("EVIDENCE.INCOMPLETE");
      const completion = CompletionSchema.parse(JSON.parse(bytes.toString()));
      assertProcessingResultMatches(input, completion, "completion");
      if (
        completion.operationId !== input.operationId ||
        completion.observationId !== input.observationId ||
        completion.inputFingerprint !== input.inputFingerprint ||
        completion.resultKey !== `results/${input.operationId}.json`
      )
        return unverified("INPUT.CONFLICT");
      await this.readVerifiedResult(input, completion);
      return { status: "verified", completion };
    } catch (error) {
      if (error instanceof Error && error.message === "INPUT.CONFLICT")
        return unverified("INPUT.CONFLICT");
      // Read/permission/transport errors must not be treated as permission to recompute.
      if (hasCode(error, "EACCES") || hasCode(error, "EIO"))
        return unverified("HANDOFF.UNAVAILABLE");
      return unverified("EVIDENCE.INCOMPLETE");
    }
  }

  private async readVerifiedResult(
    input: OcrInput,
    completion: Completion,
  ): Promise<OcrOutput> {
    const bytes = await this.load(completion.resultKey);
    if (
      !bytes ||
      bytes.length !== completion.resultByteSize ||
      sha256(bytes) !== completion.resultSha256
    )
      throw new Error("EVIDENCE.INCOMPLETE");
    const output = OcrOutputSchema.parse(JSON.parse(bytes.toString()));
    assertProcessingResultMatches(input, output, "output");
    if (
      output.operationId !== input.operationId ||
      output.observationId !== input.observationId ||
      output.inputFingerprint !== input.inputFingerprint
    )
      throw new Error("INPUT.CONFLICT");
    return output;
  }

  async read(input: OcrInput, raw: Completion): Promise<OcrOutput> {
    const completion = CompletionSchema.parse(raw),
      checked = await this.verify(input);
    if (
      checked.status !== "verified" ||
      JSON.stringify(checked.completion) !== JSON.stringify(completion)
    )
      throw new Error("EVIDENCE.INCOMPLETE");
    return this.readVerifiedResult(input, completion);
  }

  async recordReview(raw: Review): Promise<string> {
    const review = ReviewSchema.parse(raw);
    const key = `reviews/${review.operationId}.${review.inputFingerprint}.${review.stage}.${review.code}.json`;
    await this.putImmutable(key, review);
    return key;
  }
}
