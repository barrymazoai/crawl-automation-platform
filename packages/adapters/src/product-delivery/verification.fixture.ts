export function verifiedItem(clientRef: string, problem: boolean) {
  return {
    clientRef,
    recorded: true,
    ledger: {
      status: "ok",
      matchedBy: "external_id",
      identityState: "resolved",
      variantKey: null,
      error: null,
    },
    product: {
      id: "product",
      familyId: null,
      variantKey: null,
      identityState: "resolved",
      formulaId: null,
      gtin: null,
    },
    listing: {
      id: "listing",
      status: "active",
      firstSeenAt: null,
      lastSeenAt: null,
      latestSnapshotAt: null,
      latestPrice: null,
      latestCurrency: null,
      imageCount: 1,
    },
    latestFormulaHash: null,
    mismatches: [],
    problems: problem ? ["needs_review"] : [],
  };
}
