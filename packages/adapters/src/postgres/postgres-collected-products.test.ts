import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { labelCollectedHash } from "@crawl-automation/processing";
import {
  LabelCollectedProductSchema,
  type LabelCollectedProduct,
} from "@crawl-automation/v3-contracts";
import { PostgresCollectedProducts } from "./postgres-collected-products.js";

/** A real collected product, as the processing assembly produced it (collected-product/3). */
const collected = (): LabelCollectedProduct =>
  LabelCollectedProductSchema.parse(
    JSON.parse(readFileSync(new URL("./fixtures/collected-product.json", import.meta.url), "utf8")),
  );

const reversedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(reversedKeys);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, inner]) => [key, reversedKeys(inner)]),
  );
};

// Cases carried over from the former collected-product repository.
describe("PostgresCollectedProducts", () => {
  it("jsonb key order does not change the record hash; a mismatched stored hash fails", async () => {
    const record = collected();
    const row = {
      record: reversedKeys(record),
      record_hash: labelCollectedHash(record),
      observation_id: record.observation.observationId,
    };
    const repository = new PostgresCollectedProducts({ query: async <Row>() => [row] as Row[] });
    expect(await repository.read(record.operationId)).toEqual(record);
    row.record_hash = "0".repeat(64);
    await expect(repository.read(record.operationId)).rejects.toMatchObject({
      code: "LABEL_COLLECTION.INTEGRITY",
    });
  });

  it("looks an observation up and checks the stored record's hash and observation", async () => {
    const record = collected();
    const query = vi.fn(async (sql: string) =>
      sql.startsWith("SELECT operation_id")
        ? [{ operation_id: record.operationId }]
        : [
            {
              observation_id: record.observation.observationId,
              record_hash: labelCollectedHash(record),
              record,
            },
          ],
    );
    const repository = new PostgresCollectedProducts({ query } as never);
    expect(await repository.readObservation(record.observation.observationId)).toEqual(record);
    await expect(repository.readObservation("wrong-observation")).rejects.toMatchObject({
      code: "LABEL_COLLECTION.INTEGRITY",
    });
  });
});
