import type { BrandName, BrandSourceImportStore, ScanChannel } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import { z } from "zod";

const BrandRow = z.object({ brandId: z.string(), name: z.string() });

/** Brand names, and brand sources added disabled; a source that already exists is left exactly as it is. */
export class PostgresBrandSourceImport implements BrandSourceImportStore {
  constructor(private readonly database: Database) {}

  async brandNames(): Promise<BrandName[]> {
    const rows = await this.database.query(`SELECT id::text AS "brandId", name FROM brand`);
    return rows.map((row) => BrandRow.parse(row));
  }

  async addDisabledSources(
    rows: readonly { brandId: string; channel: ScanChannel; url: string }[],
  ): Promise<{ created: number; existing: number }> {
    const created = await this.database.query<{ id: string }>(
      `INSERT INTO brand_source (brand_id, channel, url, enabled)
       SELECT x.brand_id, x.channel, x.url, false
       FROM unnest($1::uuid[], $2::text[], $3::text[]) AS x(brand_id, channel, url)
       ON CONFLICT (brand_id, region, url) DO NOTHING
       RETURNING id::text AS id`,
      [rows.map((row) => row.brandId), rows.map((row) => row.channel), rows.map((row) => row.url)],
    );
    return { created: created.length, existing: rows.length - created.length };
  }
}
