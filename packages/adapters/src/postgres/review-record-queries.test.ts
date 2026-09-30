import { describe, expect, it } from "vitest";
import { listReviewsQuery } from "./review-record-queries.js";

describe("listReviewsQuery", () => {
  it("pages by review ID and passes every filter value as a parameter", () => {
    const { sql, params } = listReviewsQuery({
      limit: 20,
      before: "review-100",
      category: "PROCESSING",
      brandId: "brand-7",
    });
    expect(sql).toContain("review_id < $1");
    expect(sql).toContain("record->'failure'->>'category' = $2");
    expect(sql).toContain("record->'observation'->>'brandId' = $3");
    expect(sql).toContain("ORDER BY review_id DESC LIMIT $4");
    expect(params).toEqual(["review-100", "PROCESSING", "brand-7", 21]);
  });

  it("has no WHERE clause without filters", () => {
    const { sql, params } = listReviewsQuery({ limit: 5 });
    expect(sql).not.toContain("WHERE");
    expect(params).toEqual([6]);
  });
});
