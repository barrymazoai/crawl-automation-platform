import { isDeepStrictEqual as equal } from 'node:util';
import { DtcProductJobSchema, DtcScopeSkipSchema } from '@crawl-automation/v3-contracts';
import { sha256, type ObjectStore } from '@crawl-automation/v3-artifacts';

/** Immutable business outcome after browser cleanup; no Review or collected-product write. */
export async function recordDtcScopeSkip(raw:unknown,remote:ObjectStore,db:{query(sql:string,args?:unknown[]):Promise<{rows:any[]}>},signal:AbortSignal){
 const {job:rawJob,receipt:rawReceipt}=raw as {job:unknown;receipt:unknown},job=DtcProductJobSchema.parse(rawJob),receipt=DtcScopeSkipSchema.parse(rawReceipt);
 if(receipt.operationId!==job.operationId||receipt.url!==job.discovery.entry.url||receipt.evidenceKey!==`v3/dtc-legacy/${job.operationId}/scope-skip.json`)throw Error('DTC.SCOPE_EXCLUSION_UNVERIFIED');
 const bytes=await remote.read(receipt.evidenceKey,4*1024*1024,signal);
 if(!bytes||sha256(bytes)!==receipt.evidenceSha256)throw Error('DTC.SCOPE_EXCLUSION_UNVERIFIED');
 const proof=JSON.parse(Buffer.from(bytes).toString());
 if(proof.version!=='dtc-scope-skip/1'||proof.operationId!==job.operationId||proof.url!==receipt.url||proof.reason!==receipt.reason||proof.policy!==receipt.policy||!Array.isArray(proof.files))throw Error('DTC.SCOPE_EXCLUSION_UNVERIFIED');
 const values:Record<string,any>={};
 for(const path of ['harvest-result.json','evidence/records.json']){
  const matches=proof.files.filter((f:any)=>f.path===path);if(matches.length!==1)throw Error('DTC.SCOPE_EXCLUSION_UNVERIFIED');
  const f=matches[0];if(f.objectKey!==`v3/dtc-legacy/${job.operationId}/files/${sha256(Buffer.from(path))}`)throw Error('DTC.SCOPE_EXCLUSION_UNVERIFIED');
  const b=await remote.read(f.objectKey,4*1024*1024,signal);if(!b||b.length!==f.byteSize||sha256(b)!==f.sha256)throw Error('DTC.SCOPE_EXCLUSION_UNVERIFIED');values[path]=JSON.parse(Buffer.from(b).toString());
 }
 const harvest=values['harvest-result.json'];
 if(!equal(values['evidence/records.json'],[])||!equal(harvest.excluded,[{url:receipt.url,reason:'bundle_or_pack'}])||!equal(harvest.failed,[]))throw Error('DTC.SCOPE_EXCLUSION_UNVERIFIED');
 const record={job,receipt},hash=sha256(Buffer.from(JSON.stringify(record)));
 await db.query('INSERT INTO catalog_product_skip(discovery_id,record,record_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[job.discovery.discoveryId,record,hash]);
 const row=(await db.query('SELECT record,record_hash FROM catalog_product_skip WHERE discovery_id=$1',[job.discovery.discoveryId])).rows[0];
 if(!row||row.record_hash!==hash||!equal(row.record,record))throw Error('DTC.SCOPE_EXCLUSION_UNVERIFIED');
 return receipt;
}
