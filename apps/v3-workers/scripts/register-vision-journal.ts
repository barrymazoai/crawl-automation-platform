// Mini, operator recovery: register ONE vision result that was fully retained in the local journal (response,
// registration and completion present) but whose processing_result insert was lost to a database crash.
// Uses the production registry: schema-validated, same record hash, ON CONFLICT DO NOTHING, read-back verified.
// Refuses unless the journal record's operationId matches, the record is not already registered, and no review exists.
//   node register-vision-journal.js <label-private.json> <journal-root> <operationId>
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { VisionRecordSchema } from "@crawl-automation/v3-contracts";
import { PostgresVisionRegistry } from "@crawl-automation/v3-vision";
const [privPath, journalRoot, operationId] = process.argv.slice(2);
if (!privPath || !journalRoot || !operationId || !/^chl-[0-9a-f]{64}$/.test(operationId)) throw Error("usage: register-vision-journal.js <label-private.json> <journal-root> <chl-operationId>");
const priv = JSON.parse(await readFile(privPath, "utf8"));
const dir = join(journalRoot, "v3/vision", operationId);
for (const f of ["response.json", "completion.json"]) await readFile(join(dir, f));
const record = VisionRecordSchema.parse(JSON.parse(await readFile(join(dir, "registration.json"), "utf8")));
if (record.input.operationId !== operationId) throw Error("VISION.JOURNAL_OPERATION_MISMATCH");
const db = new pg.Pool({ connectionString: priv.database.connectionString, max: 1, statement_timeout: 10000 }); db.on("error", () => {});
try {
  const before = (await db.query("SELECT 1 FROM public.processing_result WHERE operation_id=$1", [operationId])).rowCount;
  const reviewed = (await db.query("SELECT 1 FROM review_record WHERE record->'failure'->>'operationId'=$1", [operationId])).rowCount;
  if (before) { console.log(JSON.stringify({ event: "VISION_ALREADY_REGISTERED", operationId })); process.exit(0); }
  if (reviewed) throw Error("VISION.ALREADY_REVIEWED");
  const registry = new PostgresVisionRegistry(db);
  await registry.register(record);
  const saved = await registry.read(operationId);
  console.log(JSON.stringify({ event: "VISION_JOURNAL_REGISTERED", operationId, listingId: record.input.selection.observation.listingId, verified: !!saved }));
} finally { await db.end(); }
