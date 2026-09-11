import { Id } from "@crawl-automation/v3-contracts";

export function selectedBrandId(url: URL): string | null {
  const raw = url.searchParams.get("brand");
  if (raw === null) return null;
  return Id.parse(raw);
}
export function brandLocation(url: URL, id: string): string {
  const next = new URL(url);
  next.searchParams.set("brand", Id.parse(id));
  return `${next.pathname}${next.search}${next.hash}`;
}
