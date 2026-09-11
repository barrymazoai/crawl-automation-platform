import { DtcNodeControlSchema } from '@crawl-automation/v3-contracts';
import type { DtcLiveConfig } from './dtc-live-config.js';
import type { CatalogDatabase } from '../../../packages/v3-product/src/catalog-ledger.js';

/** Mini-only ledger. A stopped/expired node never frees its task permits here. */
export class DtcMiniNode {
  constructor(private db:Pick<CatalogDatabase,'query'>,private config:DtcLiveConfig){}
  async run(raw:unknown,execution:{workflowId:string;workflowType:string}) {
    const r=DtcNodeControlSchema.parse(raw),c=this.config;
    const nodeId=r.action==='preflight'?r.nodeId:r.session.node.nodeId;
    if(nodeId!==c.nodeControl.nodeId)throw Error('DTC.NODE_IDENTITY');
    if(r.action==='preflight'){
      if(execution.workflowType!=='DtcNodePreflightWorkflow'||!execution.workflowId.startsWith('v3-dtc-doctor-'))throw Error('DTC.NODE_IDENTITY');
      const result=await this.db.query('SELECT resource_id FROM resource_capacity WHERE resource_id=$1 AND healthy AND health_until>now()',[c.browserModelResource]);
      if(result.rowCount!==1)throw Error('DTC.SHARED_MODEL_RESOURCE_UNAVAILABLE');
      await this.db.query('SELECT permit_id FROM resource_permit LIMIT 0');
      return{nodeId,status:'ready',browserResource:c.browserResource};
    }
    if(execution.workflowType!=='DtcNodeSessionWorkflow'||execution.workflowId!==`v3-dtc-node-${nodeId}`||r.session.controlQueue!==c.nodeControl.activityQueue)throw Error('DTC.NODE_IDENTITY');
    const controller=JSON.stringify([nodeId,r.session.node.host,r.session.node.root,r.session.sessionId]);
    if(r.action==='open'){
      await this.db.query('INSERT INTO resource_capacity(resource_id,capacity) VALUES($1,1) ON CONFLICT DO NOTHING',[c.browserResource]);
      const result=await this.db.query("UPDATE resource_capacity SET controller=$2,healthy=false,health_until=now(),reason='dtc_node_starting' WHERE resource_id=$1 AND capacity=1 AND (controller IS NULL OR controller=$2) RETURNING resource_id",[c.browserResource,controller]);
      if(result.rowCount!==1)throw Error('DTC.BROWSER_RESOURCE_CONFLICT');
    }else if(r.action==='health'){
      if(r.report.sessionId!==r.session.sessionId)throw Error('DTC.NODE_SESSION_CONFLICT');
      const result=await this.db.query("UPDATE resource_capacity SET healthy=$3,health_until=now()+interval '20 seconds',reason=$4 WHERE resource_id=$1 AND controller=$2 RETURNING resource_id",[c.browserResource,controller,r.report.healthy,r.report.healthy?'ready':'dtc_node_unready']);
      if(result.rowCount!==1)throw Error('DTC.NODE_SESSION_CONFLICT');
    }else{
      const result=await this.db.query("UPDATE resource_capacity SET healthy=false,health_until=now(),controller=NULL,reason='dtc_node_stopped' WHERE resource_id=$1 AND controller=$2 RETURNING resource_id",[c.browserResource,controller]);
      if(result.rowCount!==1)throw Error('DTC.NODE_SESSION_CONFLICT');
    }
    return{nodeId,sessionId:r.session.sessionId,status:r.action==='close'?'stopped':'acknowledged'};
  }
}
