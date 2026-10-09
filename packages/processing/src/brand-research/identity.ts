/** Conservative comparisons for hard ties, never fuzzy organization matching. */
export function domainOf(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return ["https:", "http:"].includes(url.protocol)
      ? url.hostname
          .toLowerCase()
          .replace(/^www\./, "")
          .replace(/\.$/, "")
      : null;
  } catch {
    return null;
  }
}

export function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function linkedinOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (domainOf(value) !== "linkedin.com" || !/^\/company\/[^/]+\/?$/.test(url.pathname)) {
      return null;
    }
    return `linkedin.com${url.pathname.toLowerCase().replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

export function sameText(left: string | null | undefined, right: string | null | undefined) {
  return Boolean(
    left && right && normalizedText(left) && normalizedText(left) === normalizedText(right),
  );
}
