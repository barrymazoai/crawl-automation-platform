import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { sha256 } from "@crawl-automation/platform";
import { captureFile } from "./archive.js";
import { dtcAgentErrors } from "./errors.js";

const Method = z.object({
  codec: z.literal("catalog-method-use/1"),
  profile: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  origin: z.url(),
  seedUrls: z.array(z.url()).min(1),
  listingProfile: z
    .object({ productLinkSelectors: z.array(z.string().min(1)).min(1) })
    .passthrough(),
});

/** Check the mechanically saved discovery profile; this does not extract any product fields. */
export async function verifyCatalogMethod(root: string, raw: unknown, sourceUrl?: string) {
  const method = Method.parse(raw);
  const bytes = await captureFile(root, "catalog-method-profile.json");
  const receipt = Method.parse(
    JSON.parse((await captureFile(root, "catalog-method-use.json")).toString()),
  );
  const profile = JSON.parse(bytes.toString()) as {
    site?: { origin?: string };
    listingProfile?: unknown;
    discovery?: { listingSeeds?: unknown };
  };
  if (
    !isDeepStrictEqual(method, receipt) ||
    sha256(bytes) !== method.sha256 ||
    profile.site?.origin !== method.origin ||
    (sourceUrl && new URL(sourceUrl).origin !== method.origin) ||
    !isDeepStrictEqual(profile.listingProfile, method.listingProfile) ||
    !isDeepStrictEqual(profile.discovery?.listingSeeds, method.seedUrls)
  ) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE", {
      details: { reason: "catalog_method_not_retained" },
    });
  }
}
