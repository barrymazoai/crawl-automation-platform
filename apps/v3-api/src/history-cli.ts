import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import pg from "pg";
import { convertHistoryInput, hash, type ConvertedProduct } from "./history/model.js";
import { ProductHistory } from "./history/store.js";
import { assertV3Database } from "./bootstrap/schema.js";
import { productServiceMaterial } from "./history/product-service.js";

async function main() {
  const [command, file, configPath] = process.argv.slice(2);
  if (!command || !["preview","import","verify","inventory","reparse","export","service-export"].includes(command))
    throw Error("HISTORY.USAGE_preview_or_import_FILE_CONFIG_or_inventory_reparse_export_CONFIG");
  let db: pg.Client | undefined;
  if (command !== "preview") {
    const path = ["import","verify"].includes(command) ? configPath : file;
    if (!path) throw Error("HISTORY.PRIVATE_CONFIG_REQUIRED");
    const cfg = JSON.parse(await readFile(path,"utf8"));
    const connection = cfg.database ?? cfg;
    if (typeof connection.connectionString !== "string") throw Error("HISTORY.DATABASE_CONFIG_REQUIRED");
    db = new pg.Client({connectionString:connection.connectionString,ssl:connection.tls?{rejectUnauthorized:true}:false,
      connectionTimeoutMillis:5000,statement_timeout:60000});
    await db.connect(); await assertV3Database(db);
  }
  try {
    const store = db ? new ProductHistory(db) : undefined;
    if (command === "inventory") { console.log(JSON.stringify(await store!.inventory())); return; }
    if (command === "reparse") {
      // All usable imported listings are candidates, including those with a formula.
      // This is a link input, never a complete directory or an absence proof.
      const rows = (await db!.query(`SELECT l.channel,l.site,s.url,
        jsonb_agg(DISTINCT jsonb_build_object('listingId',l.listing_id,'externalId',l.external_id,'basis',l.identity_basis)) expected_listings,
        array_agg(DISTINCT p.dataset ORDER BY p.dataset) datasets
        FROM product_history_listing l JOIN product_history_listing_source s USING(listing_id)
        JOIN product_history_source p USING(source_record_id)
        WHERE l.identity_basis<>'unresolved' AND s.url IS NOT NULL
        GROUP BY l.channel,l.site,s.url ORDER BY l.channel,l.site,s.url`)).rows;
      for (const row of rows) console.log(JSON.stringify({codec:"history-reparse-candidate/1",candidateId:hash([row.channel,row.site,row.url]),...row,
        mode:"full-capture-and-parse",scope:"partial",companyResolution:"deferred",identityCheck:"verify-selected-sku-before-linking"}));
      return;
    }
    if (command === "export" || command === "service-export") {
      // Lossless interchange. Internal product/company IDs are assigned by the future receiver.
      await db!.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await db!.query("DECLARE history_export NO SCROLL CURSOR FOR SELECT source_record_id,dataset,source_key,body_hash,record,issues,imported_at FROM product_history_source ORDER BY source_record_id");
      const maximum=configPath===undefined?Infinity:Number(configPath);
      if(maximum!==Infinity&&(!Number.isSafeInteger(maximum)||maximum<1))throw Error("HISTORY.EXPORT_LIMIT");
      let emitted=0;
      for (;;) {
        const rows=(await db!.query("FETCH 100 FROM history_export")).rows;if(!rows.length)break;
        for(const row of rows){
          if(emitted>=maximum)break;
          if(command==="service-export"){
            const captureId=row.record.codec==="v3-formula-history/1"?row.record.captureSourceId:null;
            const capture=captureId?(await db!.query("SELECT record FROM product_history_source WHERE source_record_id=$1",[captureId])).rows[0]?.record:undefined;
            console.log(JSON.stringify(productServiceMaterial(convertHistoryInput(row.record),capture)));emitted++;continue;
          }
          const listings=(await db!.query(`SELECT l.*,s.url FROM product_history_listing l JOIN product_history_listing_source s USING(listing_id)
            WHERE s.source_record_id=$1 ORDER BY l.listing_id`,[row.source_record_id])).rows;
          const observations=(await db!.query(`SELECT o.* FROM product_history_observation o JOIN product_history_observation_source s USING(observation_id)
            WHERE s.source_record_id=$1 ORDER BY o.observed_at NULLS LAST,o.observation_id`,[row.source_record_id])).rows;
          console.log(JSON.stringify({codec:"product-history-export/1",source:row,listings,observations,companyResolution:"deferred"}));emitted++;
        }
        if(emitted>=maximum)break;
      }
      await db!.query("COMMIT");return;
    }
    if (!file) throw Error("HISTORY.INPUT_REQUIRED");
    const stream = file.endsWith(".gz") ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
    const lines = createInterface({input:stream,crlfDelay:Infinity});
    const stats = {command,records:0,inserted:0,unchanged:0,verified:0,listings:0,metrics:0,formulas:0,undated:0,
      datasets:{} as Record<string,number>,issues:{} as Record<string,number>};
    let buffer:ConvertedProduct[]=[];
    if(command==="verify")await db!.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for await (const line of lines) {
      if (!line.trim()) continue;
      const value = convertHistoryInput(JSON.parse(line));
      stats.records++;stats.listings+=value.listings.length;stats.metrics+=value.observations.filter(o=>o.kind==="metrics").length;
      stats.formulas+=value.observations.filter(o=>o.kind==="formula").length;stats.undated+=value.observations.filter(o=>!o.observedAt).length;
      stats.datasets[value.dataset]=(stats.datasets[value.dataset]??0)+1;
      for(const issue of value.issues)stats.issues[issue]=(stats.issues[issue]??0)+1;
      if(command==="verify"){
        buffer.push(value);if(buffer.length===100){stats.verified+=await store!.verify(buffer);buffer=[];}
      }else if(store){const result=await store.append(value);if(result.inserted)stats.inserted++;else stats.unchanged++;}
      if(stats.records%1000===0)process.stderr.write(JSON.stringify({event:"HISTORY_PROGRESS",records:stats.records,inserted:stats.inserted})+"\n");
    }
    if(command==="verify"){if(buffer.length)stats.verified+=await store!.verify(buffer);await db!.query("COMMIT");}
    console.log(JSON.stringify(stats));
  } finally {await db?.end();}
}
main().catch(error=>{console.error(JSON.stringify({event:"HISTORY_FAILED",code:error instanceof Error&&error.message.startsWith("HISTORY.")?error.message:"inspect-local-diagnostic",name:error?.name??"Error"}));process.exitCode=1;});
