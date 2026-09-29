import type { Logger } from "@crawl-automation/platform";
import {
  CreateBrand,
  CreateSource,
  Id,
  ListQuery,
  ToggleSource,
  UpdateBrand,
  UpdateSource,
  type Brand,
  type Page,
  type Source,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { appErrors } from "../errors.js";

/** Every change carries a request ID; repeating the same request is safe. */
const withRequest = { requestId: Id };
export const CreateBrandSchema = CreateBrand.extend(withRequest);
export const UpdateBrandSchema = UpdateBrand.extend({ ...withRequest, brandId: Id });
export const CreateSourceSchema = CreateSource.extend({ ...withRequest, brandId: Id });
export const UpdateSourceSchema = UpdateSource.extend({
  ...withRequest,
  brandId: Id,
  sourceId: Id,
});
export const ToggleSourceSchema = ToggleSource.extend({
  ...withRequest,
  brandId: Id,
  sourceId: Id,
});
export const ListSourcesSchema = ListQuery.extend({ brandId: Id });

export interface BrandStore {
  list(query: ListQuery): Promise<Page<Brand>>;
  find(brandId: string): Promise<Brand | null>;
  sources(query: z.infer<typeof ListSourcesSchema>): Promise<Page<Source>>;
  create(input: z.infer<typeof CreateBrandSchema>): Promise<Brand>;
  update(input: z.infer<typeof UpdateBrandSchema>): Promise<Brand>;
  createSource(input: z.infer<typeof CreateSourceSchema>): Promise<Source>;
  updateSource(input: z.infer<typeof UpdateSourceSchema>): Promise<Source>;
  toggleSource(input: z.infer<typeof ToggleSourceSchema>): Promise<Source>;
}

/** Brands and their source URLs on each channel. */
export class BrandService {
  constructor(private readonly deps: { brands: BrandStore; log: Logger }) {}

  list(query: ListQuery): Promise<Page<Brand>> {
    return this.deps.brands.list(query);
  }

  async get(brandId: string): Promise<Brand> {
    const brand = await this.deps.brands.find(brandId);
    if (!brand) {
      throw appErrors.create("BRAND.NOT_FOUND", { details: { brandId } });
    }
    return brand;
  }

  sources(query: z.infer<typeof ListSourcesSchema>): Promise<Page<Source>> {
    return this.deps.brands.sources(query);
  }

  create(input: z.infer<typeof CreateBrandSchema>): Promise<Brand> {
    return this.logged("brand created", this.deps.brands.create(input));
  }

  update(input: z.infer<typeof UpdateBrandSchema>): Promise<Brand> {
    return this.logged("brand updated", this.deps.brands.update(input));
  }

  createSource(input: z.infer<typeof CreateSourceSchema>): Promise<Source> {
    return this.logged("source created", this.deps.brands.createSource(input));
  }

  updateSource(input: z.infer<typeof UpdateSourceSchema>): Promise<Source> {
    return this.logged("source updated", this.deps.brands.updateSource(input));
  }

  toggleSource(input: z.infer<typeof ToggleSourceSchema>): Promise<Source> {
    return this.logged("source toggled", this.deps.brands.toggleSource(input));
  }

  private async logged<Result extends { id: string }>(message: string, change: Promise<Result>) {
    const result = await change;
    this.deps.log.info({ id: result.id }, message);
    return result;
  }
}
