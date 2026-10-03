import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createSiteProfile, loadSiteProfile, mergeSiteProfile, normalizeListingProfile, saveSiteProfile } from "./profile-store.mjs";

/** Keep the exact executed discovery rules in the existing profile store, not only the task copy. */
export async function retainCatalogProfile(seedUrls, options) {
  if (typeof options.profileDir !== "string" || !options.profileDir.trim()) {
    throw new Error("catalog_profile_dir_required");
  }
  const startUrl = seedUrls[0];
  const prior = await loadSiteProfile(options.profileDir, startUrl);
  if (prior && !prior.profile) throw new Error("catalog_profile_unreadable");
  const listingProfile = normalizeListingProfile({
    ...options.listingProfile,
    productLinkSelectors: options.productLinkSelectors,
    paginationActions: options.paginationActions ?? options.listingProfile?.paginationActions,
    scrollListings: options.scrollListings ?? options.listingProfile?.scrollListings,
    listingScrollScreens: options.listingScrollScreens ?? options.listingProfile?.listingScrollScreens,
    listingMode: "repeated_cards",
  });
  const updates = {
    startUrl, listingProfile,
    discovery: { ...prior?.profile?.discovery, listingSeeds: seedUrls,
      storefrontOrigins: options.storefrontOrigins ?? [new URL(startUrl).origin] },
  };
  const profile = prior?.profile ? mergeSiteProfile(prior.profile, updates) : createSiteProfile(updates);
  const path = await saveSiteProfile(options.profileDir, profile);
  const bytes = await readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(options.outDir, "catalog-method-profile.json"), bytes, { flag: "wx" });
  const receipt = { codec: "catalog-method-use/1", profile: basename(path), sha256,
    origin: new URL(startUrl).origin, seedUrls, listingProfile };
  await writeFile(join(options.outDir, "catalog-method-use.json"), JSON.stringify(receipt), { flag: "wx" });
  return receipt;
}
