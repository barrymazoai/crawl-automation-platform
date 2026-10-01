/** Synthetic selected-product data assembled at test runtime, never a saved real page. */
export function syntheticIdentity(asin = "B0096M5PBW"): string {
  return `<script type="application/json">${JSON.stringify({
    storePreference: { buid: "10259", storeName: "The Alameda" },
    product: { asin },
  })}</script>`;
}
