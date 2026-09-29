/**
 * How one label-core policy (e.g. `swanson-label-core/1`) re-derives the label facts text from its source page.
 * Supplied by the channels at composition time: processing never knows a channel.
 */
export interface LabelCorePolicy {
  /** The step that produced the page the facts were read from (e.g. `channel.product-input`). */
  sourceModule: string;
  /** The version that page's producer must have, when the policy requires one. */
  sourceVersion?: string;
  /** Reads the facts text from that page exactly as the label-core step did. */
  extract(html: string): string;
}

export type LabelCorePolicies = Readonly<Record<string, LabelCorePolicy>>;
