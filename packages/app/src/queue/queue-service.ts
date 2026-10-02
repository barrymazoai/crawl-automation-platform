import type { Logger } from "@crawl-automation/platform";
import { appErrors } from "../errors.js";
import type { FamilyFormulaQuery } from "./family-formula-outcome.js";
import { reconcileFamilyFormulas } from "./reconcile-family-formulas.js";
import { ScanAdmissionSettingsSchema, type ScanAdmissionSettings } from "./scan-admission.js";
import type {
  AddToQueue,
  AmazonMigrationPreview,
  AmazonQueueHistory,
  PauseQueue,
  QueueChannel,
  QueueItemsQuery,
  QueueItemView,
  QueueLimits,
  QueueStatus,
  QueueStore,
  Requeue,
  RequeueResult,
  QueueSummaryQuery,
} from "./queue-model.js";

export interface QueueServiceDeps {
  amazonHistory: AmazonQueueHistory;
  /** The shared queue tables every channel uses. */
  channels: QueueStore;
  log: Logger;
  scanAdmission?: ScanAdmissionSettings;
}

/**
 * The product queue of every channel: add products, pause and resume intake, set how many run at once, and queue
 * finished products again. The queue dispatcher starts the work; nothing here starts a workflow directly.
 */
export class QueueService {
  private readonly scanAdmission: ScanAdmissionSettings;

  constructor(private readonly deps: QueueServiceDeps) {
    this.scanAdmission = ScanAdmissionSettingsSchema.parse(deps.scanAdmission ?? {});
  }

  status(channel: QueueChannel): Promise<QueueStatus> {
    return this.deps.channels.status(channel);
  }

  items(query: QueueItemsQuery): Promise<QueueItemView[]> {
    return this.deps.channels.items(query);
  }

  summary(query: QueueSummaryQuery) {
    return this.deps.channels.summary(query);
  }

  async add(input: AddToQueue): Promise<{ added: number; following?: number }> {
    const result = await this.deps.channels.add(input);
    const list = input.batchId;
    this.deps.log.info({ channel: input.channel, list, ...result }, "products queued");
    return result;
  }

  /** Only brand discoveries opt into the recent-terminal window. Counts survive batch replay. */
  async addScanDiscovery(input: AddToQueue) {
    const result = await this.deps.channels.add(input, this.scanAdmission);
    const counts = {
      added: result.added,
      following: result.following ?? 0,
      recent: result.recent ?? 0,
    };
    this.deps.log.info(
      { channel: input.channel, list: input.batchId, ...counts },
      "scan products queued",
    );
    return counts;
  }

  async setLimits(limits: QueueLimits): Promise<QueueStatus> {
    await this.deps.channels.setLimits(limits);
    this.deps.log.info(limits, "queue limits set");
    return this.status(limits.channel);
  }

  async pause(options: PauseQueue): Promise<QueueStatus> {
    await this.deps.channels.pause(options);
    this.deps.log.info(options, options.force ? "queue stopping" : "queue draining");
    return this.status(options.channel);
  }

  async resume(channel: QueueChannel): Promise<QueueStatus> {
    await this.deps.channels.resume(channel);
    this.deps.log.info({ channel }, "queue resumed");
    return this.status(channel);
  }

  async requeue(input: Requeue): Promise<RequeueResult> {
    const result = await this.deps.channels.requeue(input);
    const message = "dryRun" in result ? "requeue preview" : "products queued again";
    this.deps.log.info({ channel: input.channel, ...result }, message);
    return result;
  }

  amazonMigrationPreview(): Promise<AmazonMigrationPreview> {
    return this.deps.amazonHistory.migrationPreview();
  }

  familyOutcomes(query: FamilyFormulaQuery) {
    if (!this.deps.channels.familyOutcomes) {
      throw appErrors.create("QUEUE.NOT_CONFIGURED");
    }
    return this.deps.channels.familyOutcomes(query);
  }

  reconcileFamilyOutcomes(query: FamilyFormulaQuery) {
    return reconcileFamilyFormulas(this.deps.channels, query);
  }
}
