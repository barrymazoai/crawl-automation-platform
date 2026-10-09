/** Closed runs with saved sources and DTC completions newer than their last delivery snapshot. */
export interface BrandRedeliveryCandidates {
  /** Runs completed on or after this cutoff; each run is returned once. */
  findPending(completedSince: Date): Promise<string[]>;
}
