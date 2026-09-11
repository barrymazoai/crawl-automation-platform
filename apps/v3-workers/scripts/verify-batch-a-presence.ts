// Verification writes only deterministic presence receipts into this isolated test DB.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import pg from "pg";
import { PostgresCatalog } from "../../../packages/v3-product/src/catalog-ledger.js";
const root = process.argv[2]!;
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.match(root, /^\/Users\/barry\/apps\/crawlv3-batch-a\.[A-Za-z0-9]+$/);
const config = JSON.parse(await readFile(join(root, "live/deployment.json"), "utf8"));
const db = new pg.Pool({ connectionString: config.database.connectionString });
try {
  const ledger = new PostgresCatalog(db, async () => { throw Error("No catalog publication in this check"); }), checks = [];
  const rows = (await db.query("SELECT record FROM catalog_discovery ORDER BY discovery_id")).rows;
  assert.equal(rows.length, 2);
  for (const { record: d } of rows) {
    for (const mismatch of [false, true]) {
      const input = { operationId: `presence-${createHash("sha256").update(JSON.stringify([d.discoveryId, mismatch])).digest("hex")}`,
        catalogId: d.catalogId, scope: { ...d.scope, ...(mismatch ? { region: d.scope.region === "US" ? "CA" : "US" } : {}) },
        listingId: d.entry.listingId, variantId: d.entry.variantId };
      const first = await ledger.presence(input);
      assert.equal(first.status, mismatch ? "unknown" : "exists");
      assert.deepEqual(await ledger.presence(input), first);
      checks.push({ catalogId: d.catalogId, scopeMismatch: mismatch, status: first.status, idempotent: true });
    }
  }
  await writeFile(join(root, "live/presence-proof.json"), JSON.stringify({ checks, passed: true }), { mode: 0o600 });
  console.log(JSON.stringify({ checks, passed: true }));
} finally { await db.end(); }
