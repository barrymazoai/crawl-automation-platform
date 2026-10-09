import { ProductDeliveryService, type ProductDelivery } from "@crawl-automation/app";
import type { ObjectStore, Queryable } from "@crawl-automation/platform";
import type { SupplySmartRpc } from "../supply-smart/supply-smart-rpc.js";
import { PostgresDeliveryReader } from "./postgres-delivery-reader.js";
import { SupplySmartObservationWriter } from "./product-observation-writer.js";

export interface SupplySmartProductDeliveryDeps {
  database: Queryable;
  rpc: Pick<SupplySmartRpc, "call">;
  objects: Pick<ObjectStore, "read">;
}

export class SupplySmartProductDelivery implements ProductDelivery {
  private readonly service: ProductDeliveryService;
  constructor(deps: SupplySmartProductDeliveryDeps) {
    this.service = new ProductDeliveryService({
      reader: new PostgresDeliveryReader(deps),
      writer: new SupplySmartObservationWriter(deps.rpc),
    });
  }
  catalogs(...args: Parameters<ProductDelivery["catalogs"]>) {
    return this.service.catalogs(...args);
  }
  deliver(...args: Parameters<ProductDelivery["deliver"]>) {
    return this.service.deliver(...args);
  }
}
