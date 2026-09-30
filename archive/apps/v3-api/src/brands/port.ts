import type {
  Brand,
  Source,
  Page,
  Summary,
  CreateBrand,
  UpdateBrand,
  CreateSource,
  UpdateSource,
  ToggleSource,
  ListQuery,
} from "@crawl-automation/v3-contracts";

import type { Mutation } from "../shared/mutation.js";
export type { Mutation } from "../shared/mutation.js";

export interface BrandRepository {
  list(query: ListQuery): Promise<Page<Brand>>;
  get(id: string): Promise<Brand>;
  listSources(brandId: string, query: ListQuery): Promise<Page<Source>>;
  summary(): Promise<Summary>;
  create(input: CreateBrand, requestId: string): Promise<Mutation<Brand>>;
  update(
    id: string,
    input: UpdateBrand,
    requestId: string,
  ): Promise<Mutation<Brand>>;
  createSource(
    brandId: string,
    input: CreateSource,
    requestId: string,
  ): Promise<Mutation<Source>>;
  updateSource(
    brandId: string,
    sourceId: string,
    input: UpdateSource,
    requestId: string,
  ): Promise<Mutation<Source>>;
  toggleSource(
    brandId: string,
    sourceId: string,
    input: ToggleSource,
    requestId: string,
  ): Promise<Mutation<Source>>;
}
