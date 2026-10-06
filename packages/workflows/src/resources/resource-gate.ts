import { ResourceGateSchema, type ResourceRequest } from "@crawl-automation/v3-contracts";
import { workflowInfo } from "@temporalio/workflow";
import { resourceActivities } from "./resource-activities.js";
import { waitForResource } from "./wait-for-resource.js";
import { executePermit } from "./execute-permit.js";

import type { GatedWork } from "./resource-binding.js";
export type { GatedWork, ResourceActivityBinding, ResourceGrant } from "./resource-binding.js";

/**
 * One permit per step. Activity cancellation waits for acknowledgement; activity/scope timeouts also
 * enter finally. Server-enforced workflow termination/timeouts cannot execute workflow cleanup.
 */
export function resourceGate(raw: unknown) {
  const config = raw === undefined ? undefined : ResourceGateSchema.parse(raw);
  let sequence = 0;
  const waiting = { polls: 0 };
  return async <Result>(name: string, run: GatedWork<Result>): Promise<Result> => {
    const needs = config?.activities[name];
    if (!config || !needs) {
      return run();
    }
    const info = workflowInfo();
    const pool = config.pools?.[name];
    const request: ResourceRequest = {
      permitId: `permit-${info.runId}-${sequence++}`,
      workflowId: info.workflowId,
      runId: info.runId,
      needs,
      ...(pool ? { pool } : {}),
    };
    const ports = resourceActivities(config.queue);
    const grant = await waitForResource({ config, request, ports, waiting });
    return executePermit({ request, ports, config, grant }, run);
  };
}
