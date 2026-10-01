import { parseHTML } from "linkedom";
import { z } from "zod";
import { costcoErrors } from "./errors.js";

export const CostcoStoreSchema = z.strictObject({
  storeId: z.string().regex(/^\d{1,12}$/),
  label: z.string().trim().min(1).max(200),
  postalCode: z.string().regex(/^\d{5}$/),
});
export type CostcoStore = z.infer<typeof CostcoStoreSchema>;
export const COSTCO_STORE: CostcoStore = {
  storeId: "669",
  label: "Southlake",
  postalCode: "76051",
};

const SELECTOR = '[data-testid="Button_locationselector_WarehouseSelector--submit"]';
const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/** Verify only: absent warehouse is allowed on raw product HTML, never on a drawn brand list. */
export function verifyCostcoStore(
  html: string,
  store: CostcoStore,
  required = false,
): { verified: boolean; shown: string | null } {
  const { document } = parseHTML(html);
  const names = [...document.querySelectorAll(SELECTOR)]
    .map((node) => {
      const label = node.getAttribute("aria-label") ?? "";
      return /,\s*current warehouse$/i.test(label)
        ? label.replace(/,\s*current warehouse$/i, "").trim()
        : (node.textContent ?? "").trim();
    })
    .filter((text) => text && !/^(?:set|change) my warehouse$/i.test(text));
  const other = names.find((name) => normalize(name) !== normalize(store.label));
  if (other) {
    throw costcoErrors.create("COSTCO.STORE_MISMATCH", {
      details: { shown: other, expected: store.label, storeId: store.storeId },
    });
  }
  if (required && !names.length) {
    throw costcoErrors.create("COSTCO.STORE_UNVERIFIED");
  }
  return { verified: names.length > 0, shown: names[0] ?? null };
}
