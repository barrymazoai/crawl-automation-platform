import { defineErrors } from "@crawl-automation/platform";

/** Registered reasons retained in Reviews and source observations. */
export const factsErrors = defineErrors({
  "CHANNEL.DOM_TEXT_PROJECTION": {
    category: "SOURCE",
    message: "The retained text is a projection of the page DOM.",
  },
  "FACTS.AMOUNTS_MISSING": { category: "SOURCE", message: "Amounts missing." },
  "FACTS.FROM_AMAZON_BY_ASIN": {
    category: "SOURCE",
    message: "The facts came from the linked Amazon ASIN.",
  },
  "FACTS.INGREDIENT_AMOUNTS_MISSING": {
    category: "SOURCE",
    message: "Ingredient amounts missing.",
  },
  "FACTS.OTHER_INGREDIENTS_MISSING": { category: "SOURCE", message: "Other ingredients missing." },
  "FACTS.SERVING_QUANTITY_MISSING": { category: "SOURCE", message: "Serving quantity missing." },
  "FACTS.SERVING_SIZE_MISSING": { category: "SOURCE", message: "Serving size missing." },
  "FACTS.TEXT_MISSING": { category: "SOURCE", message: "Text missing." },
});
