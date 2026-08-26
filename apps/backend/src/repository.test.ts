import { describe, expect, it } from "vitest";
import { buildJobDag } from "./repository.js";

function ids() {
  let value = 0;
  return () => `id-${++value}`;
}

describe("buildJobDag", () => {
  it("routes DTC through Windows capture, one Mac process, Jakarta ingest, and cleanup", () => {
    const dag = buildJobDag({ url: "https://example.com", type: "dtc_browser", adapter: null }, ids());
    expect(dag.jobs.map((job) => [job[1], job[2], job[3]])).toEqual([
      ["capture", "browser", []],
      ["process", "process", ["id-3"]],
      ["ingest", "ingest", ["id-1"]],
      ["cleanup", "cleanup", ["id-4"]],
    ]);
    expect(dag.firstJobId).toBe("id-3");
  });

  it("routes Amazon through the fixed Mac adapter without capture or ingest artifacts", () => {
    const dag = buildJobDag({ url: "https://www.amazon.com/dp/B000000000", type: "sales_channel", adapter: "amazon" }, ids());
    expect(dag.jobs.map((job) => [job[1], job[2], job[3]])).toEqual([
      ["process", "amazon", []],
      ["cleanup", "cleanup", ["id-1"]],
    ]);
    expect(dag.firstJobId).toBe("id-1");
  });
});
