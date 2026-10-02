import type { Logger } from "@crawl-automation/platform";
import type { ChannelRegistry } from "@crawl-automation/channels-core";
import { assertSourcePolicy } from "./source-policy.js";
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
import { ListSourcesSchema, type SourceScanView } from "./source-query.js";
export * from "./source-query.js";

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

export interface BrandStore {
  list(query: ListQuery): Promise<Page<Brand>>;
  find(brandId: string): Promise<Brand | null>;
  findSource(sourceId: string): Promise<Source | null>;
  sources(query: z.infer<typeof ListSourcesSchema>): Promise<Page<SourceScanView>>;
  create(input: z.infer<typeof CreateBrandSchema>): Promise<Brand>;
  update(input: z.infer<typeof UpdateBrandSchema>): Promise<Brand>;
  createSource(input: z.infer<typeof CreateSourceSchema>): Promise<Source>;
  updateSource(input: z.infer<typeof UpdateSourceSchema>): Promise<Source>;
  toggleSource(input: z.infer<typeof ToggleSourceSchema>): Promise<Source>;
}

/** Brands and their source URLs on each channel. */
export class BrandService {
  constructor(
    private readonly deps: { brands: BrandStore; log: Logger; registry?: ChannelRegistry },
  ) {}

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

  sources(query: z.infer<typeof ListSourcesSchema>): Promise<Page<SourceScanView>> {
    return this.deps.brands.sources(query);
  }

  create(input: z.infer<typeof CreateBrandSchema>): Promise<Brand> {
    return this.logged("brand created", this.deps.brands.create(input));
  }

  update(input: z.infer<typeof UpdateBrandSchema>): Promise<Brand> {
    return this.logged("brand updated", this.deps.brands.update(input));
  }

  async createSource(input: z.infer<typeof CreateSourceSchema>): Promise<Source> {
    await this.checkSource(input);
    return this.logged("source created", this.deps.brands.createSource(input));
  }

  async updateSource(input: z.infer<typeof UpdateSourceSchema>): Promise<Source> {
    await this.checkSource(input);
    return this.logged("source updated", this.deps.brands.updateSource(input));
  }

  async toggleSource(input: z.infer<typeof ToggleSourceSchema>): Promise<Source> {
    if (input.enabled) {
      const source = await this.deps.brands.findSource(input.sourceId);
      if (!source || source.brandId !== input.brandId) {
        throw appErrors.create("BRAND.SOURCE_NOT_FOUND");
      }
      await this.checkSource(source);
    }
    return this.logged("source toggled", this.deps.brands.toggleSource(input));
  }

  private async checkSource(input: { channel: string; brandId: string; url: string }) {
    if (input.channel === "dtc") {
      const brand = await this.get(input.brandId);
      assertSourcePolicy(this.deps.registry, { ...input, brandName: brand.name });
    }
  }

  private async logged<Result extends { id: string }>(message: string, change: Promise<Result>) {
    const result = await change;
    this.deps.log.info({ id: result.id }, message);
    return result;
  }
}
