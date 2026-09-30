import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

function flag(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const stateFile = path.resolve(flag("--state") ?? "reports/amazon-backfill/state.sqlite");
const outputFile = path.resolve(flag("--output") ?? path.join(path.dirname(stateFile), "source-evidence.sqlite"));
const buildingFile = `${outputFile}.building`;
const connectionString = process.env.BACKFILL_DATABASE_URL;
if (!connectionString) throw new Error("缺少 BACKFILL_DATABASE_URL");
const source = new URL(connectionString);
if (!(["localhost", "127.0.0.1"].includes(source.hostname) && source.port === "5440" && source.pathname === "/product_restore")) {
  throw new Error(`拒绝读取非 Product Restore 源：${source.hostname}:${source.port}${source.pathname}`);
}

const state = new DatabaseSync(stateFile, { readOnly: true });
const productIds = (state.prepare("select product_id from product_task order by product_id").all() as Array<{ product_id: string }>).map((row) => row.product_id);
state.close();
if (productIds.length === 0) throw new Error("状态库没有产品任务");

await fs.mkdir(path.dirname(outputFile), { recursive: true });
await fs.rm(buildingFile, { force: true });
const snapshot = new DatabaseSync(buildingFile);
snapshot.exec(`
  pragma journal_mode=WAL;
  pragma synchronous=NORMAL;
  create table snapshot_product (
    product_id text primary key,
    image_count integer not null default 0,
    ocr_count integer not null default 0
  );
  create table source_image (
    id text primary key,
    product_id text not null,
    image_url text not null,
    image_index integer not null,
    ocr_text text
  );
  create index source_image_product_idx on source_image(product_id,image_index,id);
  create table snapshot_meta (key text primary key,value text not null);
`);
const insertProduct = snapshot.prepare("insert into snapshot_product(product_id) values(?)");
snapshot.exec("begin");
for (const productId of productIds) insertProduct.run(productId);
snapshot.exec("commit");

const pool = new pg.Pool({ connectionString, max: 2 });
const insertImage = snapshot.prepare(`insert into source_image(id,product_id,image_url,image_index,ocr_text) values(?,?,?,?,?)`);
const updateProduct = snapshot.prepare("update snapshot_product set image_count=?,ocr_count=? where product_id=?");
let imageRows = 0;
let ocrRows = 0;
try {
  for (let offset = 0; offset < productIds.length; offset += 400) {
    const chunk = productIds.slice(offset, offset + 400);
    const result = await pool.query<{
      id: string; product_id: string; image_url: string; ocr_text: string | null;
    }>(`
      select pi.id,pi.product_id,pi.image_url,
        coalesce(nullif(btrim(pi.supplement_facts_text_clean),''),nullif(btrim(pi.textract_raw_text),'')) ocr_text
      from product_image pi
      left join product_channel image_listing on image_listing.id=pi.listing_id
      where pi.product_id=any($1::uuid[])
        and coalesce(btrim(pi.image_url),'')<>''
        and (
          lower(coalesce(pi.channel,''))='amazon'
          or lower(coalesce(image_listing.channel,''))='amazon'
          or lower(pi.image_url) like 'product-images/amazon/%'
          or lower(coalesce(image_listing.original_product_url,'')) ~ '^(https?://)?([a-z0-9-]+\\.)*amazon\\.[a-z.]+([/:?#]|$)'
          or lower(coalesce(image_listing.url_normalized,'')) ~ '^(https?://)?([a-z0-9-]+\\.)*amazon\\.[a-z.]+([/:?#]|$)'
          or lower(coalesce(image_listing.website,'')) ~ '^(https?://)?([a-z0-9-]+\\.)*amazon\\.[a-z.]+([/:?#]|$)'
        )
      order by pi.product_id,pi.created_at,pi.id
    `, [chunk]);
    const counts = new Map<string, { images: number; ocr: number }>();
    snapshot.exec("begin");
    for (const row of result.rows) {
      const count = counts.get(row.product_id) ?? { images: 0, ocr: 0 };
      insertImage.run(row.id, row.product_id, row.image_url, count.images, row.ocr_text);
      count.images += 1;
      if (row.ocr_text) count.ocr += 1;
      counts.set(row.product_id, count);
      imageRows += 1;
      if (row.ocr_text) ocrRows += 1;
    }
    for (const productId of chunk) {
      const count = counts.get(productId) ?? { images: 0, ocr: 0 };
      updateProduct.run(count.images, count.ocr, productId);
    }
    snapshot.exec("commit");
    console.log(JSON.stringify({ copiedProducts: Math.min(offset + chunk.length, productIds.length), totalProducts: productIds.length, imageRows, ocrRows }));
  }
  const completedAt = new Date().toISOString();
  const insertMeta = snapshot.prepare("insert into snapshot_meta(key,value) values(?,?)");
  insertMeta.run("complete", "true");
  insertMeta.run("completed_at", completedAt);
  insertMeta.run("product_count", String(productIds.length));
  insertMeta.run("image_count", String(imageRows));
  insertMeta.run("ocr_count", String(ocrRows));
  snapshot.exec("pragma wal_checkpoint(truncate)");
  snapshot.close();
  await fs.rename(buildingFile, outputFile);
  const size = (await fs.stat(outputFile)).size;
  console.log(JSON.stringify({ status: "complete", outputFile, productCount: productIds.length, imageRows, ocrRows, byteSize: size, completedAt }, null, 2));
} catch (error) {
  try { snapshot.close(); } catch {}
  throw error;
} finally {
  await pool.end();
}
