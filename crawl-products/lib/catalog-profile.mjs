import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSiteProfile, loadSiteProfile, mergeSiteProfile, normalizeListingProfile, saveSiteProfile, siteProfileFileName } from "./profile-store.mjs";

/** Retain the candidate rules with this task; the host promotes only a verified complete catalog. */
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
  const bytes = Buffer.from(`${JSON.stringify(profile, null, 2)}\n`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(options.outDir, "catalog-method-profile.json"), bytes, { flag: "wx" });
  const receipt = { codec: "catalog-method-use/1", profile: siteProfileFileName(startUrl), sha256,
    origin: new URL(startUrl).origin, seedUrls, listingProfile };
  await writeFile(join(options.outDir, "catalog-method-use.json"), JSON.stringify(receipt), { flag: "wx" });
  return receipt;
}

/** Called by the host after its existing identity, page and completion checks, never by discovery. */
export async function promoteCatalogProfile({ profileDir, root, sourceUrl }) {
  const bytes = await readFile(join(root, "catalog-method-profile.json"));
  const receipt = JSON.parse(await readFile(join(root, "catalog-method-use.json"), "utf8"));
  const profile = JSON.parse(bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (receipt.sha256 !== digest || receipt.origin !== new URL(sourceUrl).origin
    || profile.site?.origin !== receipt.origin
    || receipt.profile !== siteProfileFileName(profile.site.startUrl)) {
    throw new Error("catalog_profile_promotion_mismatch");
  }
  const path = await saveSiteProfile(profileDir, profile);
  if (!(await readFile(path)).equals(bytes)) throw new Error("catalog_profile_promotion_bytes_changed");
}
