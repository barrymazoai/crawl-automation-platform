/** Shared ENUMERATE phase from runHarvest. Collection and extraction remain separate. */
export async function enumerateCatalog(seedUrls, options) {
  const found = options.found ?? new Set();
  const required = options.extraRoundsAfterConverge ?? 1;
  if (!Number.isInteger(required) || required < 1) throw new Error("catalog_fixpoint_invalid");
  const result = { complete: false, reason: null, zeroGrowthRounds: 0, seedReports: [], rounds: [] };
  for (let round = 1; result.zeroGrowthRounds < required; round++) {
    const breach = options.budgetBreach?.();
    if (breach) return { ...result, reason: breach, budgetExceeded: true };
    if (round > (options.maxRounds ?? Infinity)) return { ...result, reason: "round_limit" };
    const before = found.size;
    const observed = await options.enumerate(seedUrls, {
      ...options.enumerateOptions,
      // Accumulated identities belong to this outer phase. A verification walk
      // must not stop on the collector's first two already-known pages.
      known: [], knownInlineRecords: [],
    }, round);
    const urls = options.selectUrls
      ? options.selectUrls(observed.productUrls ?? []) : observed.productUrls ?? [];
    for (const url of urls) found.add(url);
    const growth = found.size - before;
    result.seedReports = observed.coverage?.seedReports ?? [];
    const coverageComplete = observed.coverage?.status === "complete";
    result.zeroGrowthRounds = coverageComplete && growth === 0 ? result.zeroGrowthRounds + 1 : 0;
    const report = { round, growth, productUrls: [...found], coverageComplete, seedReports: result.seedReports };
    result.rounds.push(report);
    await options.onRound?.(report);
    if (!coverageComplete) {
      const incomplete = result.seedReports.filter(seed => seed.status !== "complete");
      if (options.acceptProductLimit && incomplete.length && incomplete.every(seed => String(seed.endReason).includes("max_items"))) {
        return { ...result, complete: true, acceptedLimit: true };
      }
      return { ...result, reason: incomplete.map(seed => `seed_${seed.endReason || "incomplete"}:${seed.seedUrl}`).join(",") || "enumeration_incomplete" };
    }
    // A separately verified legacy end oracle may prove completion without a
    // second traversal. It must throw on conflicting or missing evidence.
    if (await options.verifyCompleteRound?.(report)) return { ...result, complete: true };
  }
  return { ...result, complete: true };
}
