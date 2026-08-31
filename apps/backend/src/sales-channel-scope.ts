export type SalesChannelInputKind = "brand_catalog" | "product" | "search";

export interface SalesChannelCatalogEvidence {
  inputKind: SalesChannelInputKind;
  exhausted: boolean;
  truncated: boolean;
  expectedCount: number | null;
  discoveredCount: number;
  processedCount: number;
}

export interface SalesChannelScopeDecision {
  scope: "full" | "partial";
  reasons: string[];
}

/**
 * Amazon、GNC、Swanson 共用的 run 级目录门禁。
 *
 * Adapter 只负责给出可验证的分页/变体证据；是否允许 full 由这里统一决定，
 * 禁止模型或单个产品自行声明。普通搜索页和单品页永远不能触发缺席下架。
 */
export function decideSalesChannelScope(input: SalesChannelCatalogEvidence): SalesChannelScopeDecision {
  const reasons: string[] = [];
  if (input.inputKind !== "brand_catalog") reasons.push(`input_${input.inputKind}_is_not_brand_catalog`);
  if (!input.exhausted) reasons.push("catalog_not_exhausted");
  if (input.truncated) reasons.push("catalog_truncated");
  if (input.expectedCount != null && input.discoveredCount < input.expectedCount) {
    reasons.push(`catalog_count_mismatch:${input.discoveredCount}/${input.expectedCount}`);
  }
  if (input.processedCount < input.discoveredCount) {
    reasons.push(`catalog_items_unprocessed:${input.processedCount}/${input.discoveredCount}`);
  }
  return { scope: reasons.length === 0 ? "full" : "partial", reasons };
}
