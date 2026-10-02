import {
  ExecutorStopVerifier,
  PostgresPermitExecutions,
  PostgresStopVerification,
  TemporalBrowserStop,
} from "@crawl-automation/adapters";
import { ResourceService, StopVerification } from "@crawl-automation/app";
import type { Database, Logger, TemporalClient } from "@crawl-automation/platform";
import type { OcrApiSettings } from "@crawl-automation/processing";
import type { PostgresResourceStore, TemporalWorkflowTree } from "@crawl-automation/adapters";

interface ResourceParts {
  config: { fleet: { ocrApi?: OcrApiSettings | undefined } };
  resourceStore: PostgresResourceStore;
  workflowTree: TemporalWorkflowTree;
  database: Database;
  temporal: TemporalClient;
  log: Logger;
}

export function resourceService(parts: ResourceParts): ResourceService {
  const resources = parts.resourceStore;
  const workflows = parts.workflowTree;
  const log = parts.log;
  const stopVerification = new StopVerification({
    resources,
    workflows,
    log,
    journal: new PostgresStopVerification(parts.database),
    verifier: new ExecutorStopVerifier({
      resources,
      ledger: new PostgresPermitExecutions(parts.database),
      browser: new TemporalBrowserStop(parts.temporal.client),
      ocr: parts.config.fleet.ocrApi,
    }),
  });
  return new ResourceService({ resources, workflows, log, stopVerification });
}
