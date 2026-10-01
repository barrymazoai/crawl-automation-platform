import type { MeasurementIdentity } from "@crawl-automation/platform";

type Fields = Record<string, unknown>;
const object = (value: unknown): Fields =>
  value !== null && typeof value === "object" ? (value as Fields) : {};
const envelopes = [
  "pipeline",
  "input",
  "owner",
  "observation",
  "plan",
  "sourcePlan",
  "manifest",
  "selection",
  "page",
  "acquire",
  "source",
  "task",
];

/** Only identity-bearing envelopes; never inspect model prompts, page text, or arbitrary result payloads. */
function identities(raw: unknown, depth = 0): Fields[] {
  const fields = object(raw);
  if (depth === 5) {
    return [fields];
  }
  return [
    fields,
    ...envelopes.flatMap((key) => (fields[key] ? identities(fields[key], depth + 1) : [])),
  ];
}

function first(rows: Fields[], keys: string[]): string | null {
  for (const row of rows) {
    for (const key of keys) {
      if (typeof row[key] === "string") {
        return row[key];
      }
    }
  }
  return null;
}

/** requestId in an observation is the owner product run, including nested vision/OCR tasks. */
export function activityIdentity(raw: unknown): MeasurementIdentity {
  const rows = identities(raw);
  const artifacts = rows.flatMap((row) => [
    row,
    object(row.file),
    object(row.image),
    object(row.page),
    object(object(row.source).document),
    object(object(row.selection).image),
    object(row.source),
  ]);
  const owners = rows.filter((row) => typeof row.observationId === "string");
  return {
    channel: first(rows, ["channel"]) ?? first(artifacts, ["channel"]),
    runId: first(rows, ["runId"]) ?? first(owners, ["requestId"]),
    operationId: first(rows, ["operationId", "collectionOperationId"]),
    sourceId:
      first(owners, ["sourceId"]) ?? first(rows, ["sourceId"]) ?? first(artifacts, ["sourceId"]),
    sourceHash: first(artifacts, ["sha256"]),
    scanId: first(rows, ["scanId"]),
    workflowId: null,
    temporalRunId: null,
  };
}
