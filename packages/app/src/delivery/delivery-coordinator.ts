import type {
  CollectionSnapshot,
  CollectionSubmission,
  DeliveryReceipt,
  DeliveryTarget,
} from "@crawl-automation/v3-contracts";
import { appErrors } from "../errors.js";
import type { DeliveryJournal, SubmissionReader, WorkflowStarter } from "./ports.js";
import { inputHash, workflowInput } from "./proof-policy.js";

export type Channel = CollectionSnapshot["channel"];

/** Where each channel's brand collections start. Every target must be on the same Temporal cluster. */
export interface DeliveryRoutes {
  clusterId: string;
  namespace: string;
  channels: Partial<Record<Channel, DeliveryTarget>>;
}

export interface DeliveryCoordinatorDeps {
  submissions: SubmissionReader;
  journal: DeliveryJournal;
  starter: WorkflowStarter;
  routes: DeliveryRoutes;
}

/**
 * Starts one accepted submission's workflow at most once, then records what Temporal shows.
 * Calling it again only checks; it never starts a second workflow.
 */
export class DeliveryCoordinator {
  constructor(private readonly deps: DeliveryCoordinatorDeps) {}

  async reconcile(requestId: string): Promise<DeliveryReceipt> {
    const { submissions, journal, starter } = this.deps;
    const submission = await submissions.get(requestId);
    const target = await this.targetFor(submission);
    const input = workflowInput(submission);
    const intent = await journal.begin(requestId, target, inputHash(input));
    if (intent.receipt.state === "CLOSED") {
      return intent.receipt;
    }
    if (intent.mayStart) {
      // A lost response or "already started" is settled by the inspection below, never by a second start.
      await starter.start(target, submission, input).catch(() => undefined);
    }
    return journal.record(requestId, await starter.inspect(target, submission));
  }

  /** An earlier intent keeps its target; a new one is routed by channel. */
  private async targetFor(submission: CollectionSubmission): Promise<DeliveryTarget> {
    const { journal, routes } = this.deps;
    const prior = await journal.get(submission.requestId);
    const target = prior?.target ?? routes.channels[submission.snapshot.channel];
    if (!target) {
      throw appErrors.create("DELIVERY.CHANNEL_NOT_CONFIGURED", {
        details: { channel: submission.snapshot.channel },
      });
    }
    if (target.clusterId !== routes.clusterId || target.namespace !== routes.namespace) {
      throw appErrors.create("DELIVERY.CLUSTER_MISMATCH", { details: { target } });
    }
    return target;
  }
}
