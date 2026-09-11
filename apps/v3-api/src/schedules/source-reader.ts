import type { Pool } from "pg";
import { Id } from "@crawl-automation/v3-contracts";
import { ApiError } from "../errors.js";

export function scheduleSourceReader(pool: Pool) {
  return async (brandId: string, sourceId: string, revision?: number) => {
    const result = await pool.query("SELECT revision,enabled FROM brand_source WHERE brand_id=$1 AND id=$2", [Id.parse(brandId), Id.parse(sourceId)]);
    const source = result.rows[0];
    if (!source) throw new ApiError(404, "SOURCE_NOT_FOUND", "Source not found");
    if (revision !== undefined && source.revision !== revision) throw new ApiError(409, "REVISION_CONFLICT", "Source changed; refresh before enabling a schedule");
    if (revision !== undefined && !source.enabled) throw new ApiError(409, "SOURCE_DISABLED", "Enable source before configuring an active schedule");
  };
}
