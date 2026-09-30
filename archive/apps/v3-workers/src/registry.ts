import { RoleRegistry } from "@crawl-automation/v3-worker-runtime";

// Register actual business role factories here as their own implementation tasks pass.
// Catalog/Product orchestration: tasks 36/25. Atomic providers: tasks 18–24/32–35.
// No Probe, mock OCR or dynamic import path from deployment configuration.
export const businessRegistry = new RoleRegistry("business", []);
