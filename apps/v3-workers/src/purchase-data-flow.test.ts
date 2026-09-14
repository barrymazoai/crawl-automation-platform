import {expect,it} from 'vitest';
import {AmazonLiveProduct} from '../../../packages/v3-channels/src/amazon-live-product.js';
import {ChannelLabelPlans} from '../../../packages/v3-channels/src/channel-label.js';
import {amazonFixture,AmazonMemory,RetainedPublication} from '../../../packages/v3-channels/src/amazon-live.fixture.js';
import {purchaseFixture} from '../../../packages/v3-channels/src/purchase-conditions.fixture.js';
import {commerceMetrics} from './history-observations.js';
import {convertHistoryInput} from '../../v3-api/src/history/model.js';
import {productServiceMaterial} from '../../v3-api/src/history/product-service.js';
const signal=()=>AbortSignal.timeout(10000);

it.each([false,true])('old/new capture survives cold image binding, label planning and lossless export: conditions=%s',async present=>{
 const f=amazonFixture(),conditions=purchaseFixture();
 const commerce={codec:'public-product-commerce/1',sku:null,price:'$7.99',currency:'USD',listPrice:null,rating:null,reviewCount:null,availability:'In Stock',context:['One-time purchase'],...(present?{purchaseConditions:conditions}:{})};
 Object.assign(f.product,{commerce});
 const job=await f.job(),capture=await f.live.capture(job,signal()),original=Buffer.from(f.remote.data.get(capture.sourcePlan.source.objectKey)!);
 expect((await f.plans.run(capture.sourcePlan,signal())).status).toBe('prepared');
 const cold=new AmazonLiveProduct(new RetainedPublication(new AmazonMemory(),f.remote),f.settings);
 expect(await cold.capture(job,signal())).toEqual(capture);expect(await cold.filePageUrl(capture,signal())).toBe(f.url);
 expect(f.productBrowser.capture).toHaveBeenCalledOnce();
 const labelInput={operationId:'label-conditions',sourcePlan:capture.sourcePlan,text:{...f.settings.text,implementationVersion:'codex-text/3',policyVersion:'label-text/1',resultSchemaVersion:3},visionConfigFingerprint:f.settings.visionConfigFingerprint,evidencePolicy:'label-image-first/3'};
 const labels=new ChannelLabelPlans(f.plans,f.publication,async()=>({status:'not_matched'}));
 const loaded=await labels.load(labelInput,signal());expect(loaded.manifest.sources.length).toBeGreaterThan(0);
 const image=loaded.manifest.sources.find(s=>s.kind==='file-image')!;
 expect((await labels.source({input:labelInput,sourceId:image.id},signal())).status).toBe('not_matched');
 const metrics=commerceMetrics(commerce),raw={codec:'v3-capture-history/1',dataset:'v3:amazon',observationId:capture.sourcePlan.owner.observationId,owner:capture.sourcePlan.owner,
  capturedAt:f.product.capturedAt,listing:{channel:'amazon',url:f.url,externalId:f.product.asin},metrics,evidence:[{objectKey:capture.sourcePlan.source.objectKey,sha256:capture.sourcePlan.source.sha256}],capture:{projection:f.product}};
 const value=convertHistoryInput(raw),output=productServiceMaterial(value),item=(output.metrics[0] as any).items[0];
 expect(output.retained.raw).toEqual(raw);expect(item.price).toBe('7.99');
 if(present){expect(metrics.extras?.purchaseConditions).toEqual(conditions);expect(item.extras.purchaseConditions).toEqual(conditions);}
 else {expect(metrics.extras).not.toHaveProperty('purchaseConditions');expect(item.extras).not.toHaveProperty('purchaseConditions');}
 expect(f.remote.data.get(capture.sourcePlan.source.objectKey)).toEqual(original);
});
