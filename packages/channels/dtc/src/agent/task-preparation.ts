import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EgoAgentPage } from "@crawl-automation/platform";
import type { AgentCaptureRequest } from "./request.js";
import { prepareSiteMethod } from "./site-method.js";
import { prepareCatalogScript } from "../../../../../crawl-products/lib/catalog-script-store.mjs";

export async function prepareCaptureTask(
  request: AgentCaptureRequest,
  input: {
    cwd: string;
    outDir: string;
    page: EgoAgentPage;
    skillRoot: string;
    profileDir: string;
    taskSpaceId: number;
  },
) {
  await writeFile(join(input.cwd, "browser-preparation.mjs"), input.page.preparationModule(), {
    flag: "wx",
  });
  const { page, ...paths } = input;
  const common = { ...paths, label: page.label, targetId: page.targetId };
  if (request.mode === "catalog") {
    await prepareCatalogScript({ ...common, sourceUrl: request.url });
  } else if (request.mode === "product") {
    await prepareSiteMethod({ ...common, productUrl: request.url });
  }
}
