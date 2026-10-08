/**
 * Owner 2026-10-08: a product the store itself files outside supplements (baby care, beauty, home, equipment) and whose
 * label step would go to Review finishes as "not a supplement" instead. The store's own breadcrumb is the evidence;
 * titles are never guessed from.
 */
const MAX_CRUMBS = 20;

/** The names of a schema.org BreadcrumbList in parsed JSON-LD values, in position order. */
export function breadcrumbNames(values: unknown[]): string[] {
  const lists: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || lists.length) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((member) => visit(member, depth + 1));
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const record = value as Record<string, unknown>;
    const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
    if (types.includes("BreadcrumbList")) {
      lists.push(record);
      return;
    }
    visit(record["@graph"], depth + 1);
  };
  values.forEach((value) => visit(value, 0));
  const items = lists[0]?.itemListElement;
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map(
      (item: unknown) => item as { position?: unknown; name?: unknown; item?: { name?: unknown } },
    )
    .map((item, index) => ({
      position: typeof item.position === "number" ? item.position : index,
      name: crumb(item.name ?? item.item?.name),
    }))
    .filter((item): item is { position: number; name: string } => item.name !== null)
    .sort((left, right) => left.position - right.position)
    .map((item) => item.name)
    .slice(0, MAX_CRUMBS);
}

function crumb(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.replace(/\s+/gu, " ").trim().slice(0, 200)
    : null;
}

/** The breadcrumb, when one of its names is a category the channel files outside supplements; otherwise null. */
export function nonSupplementPath(
  categories: readonly string[] | undefined,
  outside: readonly string[] | undefined,
): string[] | null {
  if (!categories?.length || !outside?.length) {
    return null;
  }
  const names = new Set(outside.map((name) => name.toLowerCase()));
  return categories.some((name) => names.has(name.toLowerCase())) ? [...categories] : null;
}

/** The breadcrumb from the page's JSON-LD script texts; a block that does not parse is skipped. */
export function jsonLdBreadcrumbs(scripts: string[]): string[] {
  const values = scripts.flatMap((text) => {
    try {
      return [JSON.parse(text) as unknown];
    } catch {
      return [];
    }
  });
  return breadcrumbNames(values);
}
