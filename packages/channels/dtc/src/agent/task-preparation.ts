import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  // Owner 2026-10-25: bind the task directory and shared receipt writer into every Ego round. Only a product capture
  // records a redirect as a moved product (owner 2026-10-28): a site analysis following a collection-scoped link to
  // its canonical /products/ address (autoimmunehn.com) opened the same product, not a moved one.
  const moves =
    request.mode === "product"
      ? {
          workDir: input.cwd,
          nativeOriginalsModuleUrl: pathToFileURL(
            join(input.skillRoot, "lib/ego-native-originals.mjs"),
          ).href,
        }
      : {};
  await writeFile(
    join(input.cwd, "browser-preparation.mjs"),
    input.page.preparationModule({ outDir: input.outDir, ...moves }),
    {
      flag: "wx",
    },
  );
  const { page, ...paths } = input;
  const common = { ...paths, label: page.label, targetId: page.targetId };
  if (request.mode === "catalog") {
    await prepareCatalogScript({ ...common, sourceUrl: request.url });
  } else if (request.mode === "product") {
    await prepareSiteMethod({ ...common, productUrl: request.url });
  }
}
