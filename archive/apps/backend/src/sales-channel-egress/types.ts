export interface SalesChannelEgressExit {
  id: string;
  proxyName: string;
}

export interface SalesChannelEgressPolicy {
  channel: string;
  pool: string;
  selector: string;
  exits: SalesChannelEgressExit[];
  batchSize: number;
  challengeCooldownMs: number;
  networkFailureCooldownMs: number;
  maxFailureRetries: number;
}

export interface SalesChannelNavigationRotation {
  maxFailureRetries: number;
  shouldRotateBeforeProduct(): boolean;
  rotateAfterBatch(): Promise<boolean>;
  rotateAfterFailure(reason: "challenge" | "network"): Promise<boolean>;
  recordProductSuccess(): void;
}
