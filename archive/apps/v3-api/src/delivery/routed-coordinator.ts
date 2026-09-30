import { DeliveryTarget, type CollectionSnapshot } from "@crawl-automation/v3-contracts";
import type { SubmissionRepository } from "../submissions/port.js";
import type { DeliveryJournal, WorkflowGateway } from "./port.js";
import { DeliveryCoordinator } from "./coordinator.js";
export type ChannelTargets = Partial<Record<CollectionSnapshot["channel"], DeliveryTarget>>;

/** Route only new intents. A previously issued intent always keeps its persisted destination. */
export class RoutedDeliveryCoordinator {
  constructor(private readonly submissions: SubmissionRepository, private readonly journal: DeliveryJournal,
    private readonly routes: ChannelTargets, private readonly gateway: (target: DeliveryTarget) => WorkflowGateway,
    private readonly cluster: Pick<DeliveryTarget, "clusterId" | "namespace">) {}
  async reconcile(requestId: string) {
    const submission = await this.submissions.get(requestId), prior = await this.journal.get(requestId);
    const raw = prior?.target ?? this.routes[submission.snapshot.channel];
    if (!raw) throw Error("DELIVERY.CHANNEL_NOT_CONFIGURED");
    const target = DeliveryTarget.parse(raw);
    if (target.clusterId !== this.cluster.clusterId || target.namespace !== this.cluster.namespace) throw Error("DELIVERY.CLUSTER_MISMATCH");
    // begin() still checks the immutable target/hash transactionally if another dispatcher won the race.
    return new DeliveryCoordinator(this.submissions, this.journal, this.gateway(target)).reconcile(requestId);
  }
}
