/** 拿真实抓取产物测成分表完整性判定，逐项列出哪一关没过。 */
import fs from "node:fs";
import { hasCompleteFactsText } from "../src/gnc/facts.js";

const file = process.argv[2]!;
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const text: string = data.factsText ?? "";
const normalized = text.replace(/\s+/g, " ").trim();

console.log(`factsText ${text.length} 字符 · hasCompleteFactsText = ${hasCompleteFactsText(text)}`);
console.log(`规范化后 ${normalized.length} 字符（需 >= 120）`);

const signals: [RegExp, string][] = [
  [/\bserving\s+size\b/i, "serving size"],
  [/\bservings?\s+per\s+(?:container|package)\b/i, "servings per container"],
  [/\bamount\s+per\s+serving\b/i, "amount per serving"],
  [/\b(?:%\s*)?daily\s+value\b/i, "daily value"],
  [/\bactive\s+ingredients?\b/i, "active ingredients"],
];
console.log("结构信号（需 >= 2）:");
for (const [pattern, name] of signals) console.log(`  ${pattern.test(normalized) ? "✓" : "✗"} ${name}`);

const conventional = "mcg|µg|ug|mg|g|iu|ml|cfu|billion|million|calories?";
const activity = "du|agu|hut|fip|cu|bgu|xu|galu|su|alu|lcu|hcu|pgu|endo-pgu|gdu|mcu|sapu|papu|apu|lapu|pc|fcc|usp";
const amounts = normalized.match(new RegExp(`\\b\\d[\\d,]*(?:\\.\\d+)?\\s*(?:${conventional}|${activity})\\b`, "gi"));
console.log(`剂量词（需 >= 2）: ${amounts?.length ?? 0} 个 → ${(amounts ?? []).slice(0, 8).join(", ")}`);
console.log(`\n正文前 260:\n  ${normalized.slice(0, 260)}`);
