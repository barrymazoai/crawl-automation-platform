import { z } from "zod";
import { captureFile, type CaptureFile } from "./archive.js";
import { dtcAgentErrors } from "./errors.js";
import { dtcProductAddress } from "../address.js";
import type { DtcSitePolicy } from "../site-policy.js";

const Discovery = z.object({
  codec: z.literal("catalog-discovery/1"),
  complete: z.boolean(),
  zeroGrowthRounds: z.number().int().nonnegative(),
  productUrls: z.array(z.url()),
  pages: z
    .array(
      z.object({
        round: z.number().int().positive(),
        htmlPath: z.string(),
        screenshotPath: z.string(),
      }),
    )
    .min(1),
  rounds: z
    .array(
      z.object({
        round: z.number().int().positive(),
        growth: z.number().int().nonnegative(),
        coverageComplete: z.boolean(),
        productUrls: z.array(z.url()),
      }),
    )
    .min(1)
    .max(100),
});
type DiscoveryProof = z.infer<typeof Discovery>;
type Expected = {
  complete: boolean;
  zeroGrowthRounds: number;
  listingIds: Set<string>;
  site: DtcSitePolicy;
};

/** Verify the retained mechanical round trace, not an agent-written stable-round count. */
export async function verifyCatalogDiscovery(
  saved: { root: string; files: CaptureFile[] },
  expected: Expected,
) {
  const proof = Discovery.parse(
    JSON.parse((await captureFile(saved.root, "catalog-discovery.json")).toString()),
  );
  const known = new Set(saved.files.map((file) => file.path));
  const { consistent, stable, seen } = measuredRounds(proof);
  if (
    !known.has("catalog-discovery.json") ||
    !consistent ||
    !sameProducts(proof, { seen, expected }) ||
    proof.zeroGrowthRounds !== stable ||
    expected.zeroGrowthRounds !== stable ||
    !retainedPages(proof, known) ||
    (expected.complete && !completeRounds(proof, stable))
  ) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE", {
      details: { reason: "catalog_rounds_unverified" },
    });
  }
}

function measuredRounds(proof: DiscoveryProof) {
  const seen = new Set<string>();
  let stable = 0;
  let consistent = true;
  for (const [index, round] of proof.rounds.entries()) {
    const before = seen.size;
    for (const url of round.productUrls) {
      seen.add(url);
    }
    const growth = seen.size - before;
    consistent &&= round.round === index + 1 && growth === round.growth;
    stable = round.coverageComplete && growth === 0 ? stable + 1 : 0;
  }
  return { consistent, stable, seen };
}

function sameProducts(proof: DiscoveryProof, scope: { seen: Set<string>; expected: Expected }) {
  const { seen, expected } = scope;
  const ids = new Set(
    proof.productUrls.map((url) => dtcProductAddress(url, [expected.site]).listingId),
  );
  return (
    proof.productUrls.length === seen.size &&
    proof.productUrls.every((url) => seen.has(url)) &&
    ids.size === expected.listingIds.size &&
    [...ids].every((id) => expected.listingIds.has(id))
  );
}

function retainedPages(proof: DiscoveryProof, known: Set<string>) {
  return proof.pages.every((page) => known.has(page.htmlPath) && known.has(page.screenshotPath));
}

function completeRounds(proof: DiscoveryProof, stable: number) {
  return (
    proof.complete &&
    proof.rounds.length >= 2 &&
    stable >= 1 &&
    proof.rounds.every(
      (round) => round.coverageComplete && proof.pages.some((page) => page.round === round.round),
    )
  );
}
