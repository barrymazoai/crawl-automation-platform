import { PostgresExecutionRegistry, PostgresResourceAdmission } from "@crawl-automation/adapters";
import { LabelReviews, LabelTasks } from "@crawl-automation/app";
import type { CoreParts } from "../core-parts.js";
import { workerErrors } from "../errors.js";
import { requireRoleSection } from "../processes/role-settings.js";
import { labelModels, type LabelModels } from "./label-models.js";
import { labelSteps, type LabelSteps } from "./label-steps.js";
import { labelStores, type LabelStores } from "./label-stores.js";

/** Everything the label roles run on: stores, steps, and the model and OCR clients. */
export interface LabelParts {
  stores: LabelStores;
  steps: LabelSteps;
  models: LabelModels;
}

/** Built only when a label role first needs it; a worker without the `processing` settings cannot run one. */
export function buildLabelParts(parts: CoreParts): LabelParts {
  const settings = parts.config.processing;
  if (!settings) {
    throw workerErrors.create("WORKER.PROCESSING_SETTINGS_MISSING", {
      details: { part: "processing" },
    });
  }
  const stores = labelStores(parts, settings);
  return { stores, steps: labelSteps(parts, stores), models: labelModels(stores) };
}

/** The shared Label workflow's input for a planned product (the pipeline role builds it; no model settings). */
export function buildLabelTasks(parts: CoreParts): LabelTasks {
  const { registry, channelPlans: plans, publication: evidence, database, config } = parts;
  const executions = new PostgresExecutionRegistry(database);
  const settings = requireRoleSection(config, "label", "pipeline");
  return new LabelTasks({ registry, plans, evidence, executions, settings });
}

/** A label product's own Review when it stops before its manifest. */
export function buildLabelReviews(parts: CoreParts): LabelReviews {
  return new LabelReviews({
    evidence: parts.publication,
    reviews: parts.reviewLedger,
    diagnostics: parts.publication.remote,
  });
}

/** Resource permits: short ledger transactions for the permit gates in the workflows. */
export function buildAdmission(parts: CoreParts): PostgresResourceAdmission {
  return new PostgresResourceAdmission(parts.database);
}
