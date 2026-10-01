export function words(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export const normalizedText = (value: string) => value.toLowerCase().replace(/\s+/gu, " ");

export function printedStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [normalizedText(value)];
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(printedStrings);
  }
  return [];
}

export function unsupportedWord(value: string, source: Set<string>): string | undefined {
  return words(value).find((word) => !source.has(word));
}
