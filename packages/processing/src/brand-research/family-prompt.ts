import { browserPrompt, type BrowserPromptInput } from "./browser-prompt.js";

export function familyPrompt(input: BrowserPromptInput): string {
  return `${browserPrompt(input)}
TASK: Inspect the supplied brand URL and its actual landing page, navigation, About, brand-family and footer pages.
Report where it really lands. Distinguish a redirect to another domain of the SAME brand (regional/renamed/former)
from a redirect to ANOTHER company. Only the latter produces a domain_redirect ownership clue, with a verbatim
quote from the landing company's page and that actual URL. A shared domain or redirect alone must not invent an owner.
For an absorbed brand (redirect.sameBrand false) or a shared retailer, find the collection/brand page on the landed
site listing ONLY this subject brand's products. Visit and save that page as evidence and return its URL as catalogUrl.
Never use the owner's whole store as catalogUrl. Use null if no such page is verified, or the landed site is wholly
this brand's own. A collection's products, not the site's navigation or recommendations, determine its scope.
Determine isNutrition from the actual business. shape is exactly single (one brand), separate_sites (group with
sub-brands on their own sites), shared_site (several brand lines on this site), or holding (group without own products).
A sub-brand is a DISTINCT BRAND NAME that products are sold under (printed on their packaging, or the shop's vendor/
brand field), not a product category, collection, line descriptor, age group or use case of this brand (e.g.
"Everyday Kids", "Medical Nutrition", "Protein Shakes", "Women's Health" are categories, not sub-brands). Its
evidence quote must contain the sub-brand's name. When unsure, report shape single with no sub-brands. When the
URL forwards to ANOTHER company, the brands on that company's site are the owner's (siblings of this brand): report
shape single with no sub-brands.
List the directly observed sub-brands with name, their own URL or null, isNutrition, and verbatim quote + page URL.
Report what you see, including non-nutrition sub-brands; do not impose the application's 20-brand admission limit.
Do not run products or recursively investigate a sub-brand's family. The application owns fan-out and admission.
otherDomains contains ONLY this subject brand's own regional/former domains, never its owner's or sub-brands' domains.
When an owner's own site explicitly lists THIS subject brand, record website_our_brands naming that owner. Do not
mistake the subject's list of children for evidence that one child owns the subject.
"Manufactured by X" or "Distributed by X" does not prove ownership. Do not emit either as an ownership clue.
Use only domain_redirect and website_our_brands clues here. If the supplied URL is absent or the identity cannot
be established, return blocked with the limitation. No native web search is required for this task.`;
}
