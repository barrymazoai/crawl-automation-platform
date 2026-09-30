import { createHash } from "node:crypto";

/** Stable, contract-safe keys; JSON tuple encoding prevents site/ID delimiter collisions. */
export function dtcIdentityKey(siteKey: string, productId: string): string {
  return `dtc-${createHash("sha256")
    .update(JSON.stringify([siteKey, productId]))
    .digest("hex")}`;
}
