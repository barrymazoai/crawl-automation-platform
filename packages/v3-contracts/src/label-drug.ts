/** Printed panel/section vocabulary, shared by source scoping and label validation. No runtime I/O. */
export const drugFactsHeading = /^Drug\s+Facts\s*:?$/i;
export const drugActiveHeading = /^Active\s+ingredients?(?:\(s\))?(?:\s+\(in each[^\n]+\))?\s*:?$/i;
export const drugInactiveHeading = /^Inactive\s+ingredients\s*:?$/i;
export const factsHeadingLines = /^[ \t]*(?:Supplement|Nutrition|Drug) Facts[ \t]*:?[ \t]*$/gim;

/** Exact section starts: body words such as "inactive ingredients" in a warning are not headings. */
export const drugSectionLines =
  /^[ \t]*(?:Drug Facts|Active ingredients?(?:\(s\))?(?:[ \t]+\(in each[^\n]+\))?|Purpose|Uses|Warnings?|Directions|Other information|Inactive ingredients|Questions\??)[ \t]*(?::[^\n]*|$)/gim;

export const drugExcludedSection = /^(?:Uses|Warnings?|Directions|Other information|Questions\??)\s*:?$/i;
