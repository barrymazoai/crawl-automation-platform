import { randomUUID } from "node:crypto";
import {
  PagePrepareInputSchema,
  PageTablesSchema,
  PreparedPageRecordSchema,
  TextDocumentSchema,
  observationIdentity,
  type ArtifactRef,
  type PagePrepareInput,
  type PagePrepareOutcome,
  type PreparedPageRecord,
} from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/v3-artifacts";
import { claimOnce } from "../publication/claim-once.js";
import { encodeJson, hashString } from "../results/result-record.js";
import { writeOnce } from "../results/write-once.js";
import { pageFailure } from "./page-errors.js";
import type { PageEvidence } from "./page-evidence.js";
import { checkedPageInput, pageCompletionKey, pagePolicy } from "./page-input.js";
import { parsePage } from "./page-parser.js";

const RETENTION_MS = 10_000;
const MAX_TEXT_LENGTH = 200_000;
const COMPLETION_LIMIT = 65_536;

interface PreparedFiles {
  record: PreparedPageRecord;
  files: [key: string, value: unknown][];
}

/** Prepares a captured page once: its text document and tables, kept locally, then published to R2. */
export class PagePreparation {
  constructor(private readonly evidence: PageEvidence) {}

  async run(raw: unknown, signal: AbortSignal): Promise<PagePrepareOutcome> {
    const input = PagePrepareInputSchema.parse(raw);
    try {
      checkedPageInput(input);
      signal.throwIfAborted();
      const prior = await this.evidence.inspect(input, signal);
      if (prior) {
        return { status: "durable", record: prior };
      }
      return { status: "durable", record: await this.prepare(input, signal) };
    } catch (error) {
      const finished = await this.finishedMeanwhile(input);
      return finished ?? this.evidence.review(input, "page.prepare", error);
    }
  }

  private async prepare(input: PagePrepareInput, signal: AbortSignal): Promise<PreparedPageRecord> {
    const source = await this.evidence.source(input, signal);
    const intent = encodeJson({ input, nonce: randomUUID() });
    await claimOnce(
      this.evidence.deps.remote,
      { key: `page-intents/${input.operationId}.json`, bytes: intent },
      {
        signal,
        unknown: () => pageFailure("PAGE.INTENT_UNKNOWN"),
        executionUnknown: () => pageFailure("PAGE.EXECUTION_UNKNOWN"),
      },
    );
    const prepared = preparedFiles(input, source, signal);
    await this.keepLocally(prepared.files);
    const limits = [pagePolicy.maxOutputBytes, pagePolicy.maxOutputBytes, COMPLETION_LIMIT];
    for (const [index, [key, value]] of prepared.files.entries()) {
      await this.evidence.publish(key, value, { limit: limits[index] ?? COMPLETION_LIMIT, signal });
    }
    const verified = await this.evidence.inspect(input, signal);
    if (!verified) {
      throw pageFailure("PAGE.NOT_DURABLE");
    }
    return verified;
  }

  /** Every computed file is kept locally before anything is published; nothing is cleaned up afterwards. */
  private async keepLocally(files: PreparedFiles["files"]): Promise<void> {
    const signal = AbortSignal.timeout(RETENTION_MS);
    for (const [key, value] of files) {
      await writeOnce(
        this.evidence.deps.local,
        { key, bytes: encodeJson(value) },
        { signal, mismatch: () => pageFailure("PAGE.LOCAL_UNVERIFIED") },
      );
    }
  }

  /** After a failure, a page that was in fact prepared still counts; it is never prepared or uploaded again. */
  private async finishedMeanwhile(input: PagePrepareInput): Promise<PagePrepareOutcome | null> {
    try {
      const record = await this.evidence.inspect(input, AbortSignal.timeout(RETENTION_MS));
      return record ? { status: "durable", record } : null;
    } catch {
      // Whether it finished cannot be shown now; the failure is recorded as a Review instead.
      return null;
    }
  }
}

/** The text document, the tables and the completion record of one parsed page. */
function preparedFiles(
  input: PagePrepareInput,
  source: Uint8Array,
  signal: AbortSignal,
): PreparedFiles {
  const parsed = parsePage(input, source, signal);
  if (parsed.text.length > MAX_TEXT_LENGTH) {
    throw pageFailure("PAGE.TEXT_LIMIT");
  }
  const document = TextDocumentSchema.parse({
    ...observationIdentity(input),
    producer: "page.prepare",
    source: input.page,
    pageIndex: null,
    text: parsed.text,
  });
  const tables = PageTablesSchema.parse(parsed.tables);
  const record = PreparedPageRecordSchema.parse({
    schemaVersion: 1,
    codec: "prepared-page/1",
    input,
    document: pageFileRef(input, { name: "document", value: document }),
    tables: pageFileRef(input, { name: "tables", value: tables }),
    textLength: parsed.text.length,
  });
  const files: PreparedFiles["files"] = [
    [record.document.objectKey, document],
    [record.tables.objectKey, tables],
    [pageCompletionKey(input), record],
  ];
  return { record, files };
}

function pageFileRef(input: PagePrepareInput, file: { name: string; value: unknown }): ArtifactRef {
  const bytes = encodeJson(file.value);
  return {
    schemaVersion: 1,
    artifactId: `page-${file.name}-${hashString(input.operationId)}`,
    observationId: input.observationId,
    sourceId: input.sourceId,
    listingId: input.listingId,
    variantId: input.variantId,
    kind: "result-json",
    mediaType: "application/json",
    byteSize: bytes.length,
    sha256: sha256(bytes),
    objectKey: `v3/pages/${input.operationId}/${file.name}.json`,
    producer: {
      module: input.module,
      operationId: input.operationId,
      implementationVersion: input.implementationVersion,
    },
  };
}
