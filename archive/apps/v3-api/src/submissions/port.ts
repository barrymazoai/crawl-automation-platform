import type { CollectionSubmission, SubmitCollection } from "@crawl-automation/v3-contracts";
import type { Mutation } from "../shared/mutation.js";

export interface SubmissionRepository {
  accept(brandId: string, sourceId: string, input: SubmitCollection, requestId: string): Promise<Mutation<CollectionSubmission>>;
  get(requestId: string): Promise<CollectionSubmission>;
  active(brandId: string, sourceId: string): Promise<CollectionSubmission | null>;
}
