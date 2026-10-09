/** Closed runs with the latest products attempt's sources and completions newer than its delivery snapshot. */
export interface BrandRedeliveryCandidates {
  /** Runs completed on or after this cutoff; each run is returned once. */
  findPending(completedSince: Date): Promise<string[]>;
}
