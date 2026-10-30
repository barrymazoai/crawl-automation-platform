import type { WorkerParts } from "../container.js";

/**
 * A model step that runs on the label model queue under the label text model's resources (product enrichment, the DTC
 * review scope). Null when the label settings name no text model resource.
 */
export function textModelRoute(parts: Pick<WorkerParts, "config">, activity: string) {
  const settings = parts.config.label?.shared;
  const resources = settings?.resources;
  const needs = resources?.activities["interpretText"];
  if (!settings || !resources || !needs?.length) {
    return null;
  }
  return {
    queue: settings.queues.model,
    resources: { ...resources, activities: { [activity]: needs } },
  };
}
