import { parse, type Node, type ObjectExpression, type Property } from "acorn";
import { simple } from "acorn-walk";
import type { AmazonDocument } from "./dom.js";

export interface ScriptData {
  galleries: unknown[];
  families: { parentAsin: unknown; dimensions: unknown; members: unknown }[];
  warnings: string[];
}

function propertyName(property: Property): string | null {
  if (property.computed || property.kind !== "init") {
    return null;
  }
  const key = property.key;
  return key.type === "Identifier" ? key.name : key.type === "Literal" ? String(key.value) : null;
}

function property(object: ObjectExpression, name: string): Node | undefined {
  return object.properties.find(
    (entry): entry is Property => entry.type === "Property" && propertyName(entry) === name,
  )?.value;
}

/**
 * Acorn decodes JS string escapes. Only JSON literals are interpreted; calls are never executed.
 */
function literal(node: Node | undefined, source: string): unknown {
  if (!node) {
    return null;
  }
  // JSON.parse handles objects/arrays; Acorn handles the single-quoted gallery JSON string.
  if (node.type === "Literal") {
    return (node as import("acorn").Literal).value;
  }
  if (node.type === "CallExpression") {
    const call = node as import("acorn").CallExpression;
    const name = source.slice(call.callee.start, call.callee.end);
    const argument = call.arguments[0];
    if (name === "A.$.parseJSON" && call.arguments.length === 1 && argument?.type === "Literal") {
      return typeof argument.value === "string" ? JSON.parse(argument.value) : null;
    }
    return null;
  }
  return JSON.parse(source.slice(node.start, node.end));
}

function collect(object: ObjectExpression, source: string, result: ScriptData): void {
  const colors = property(object, "colorImages");
  if (colors?.type === "ObjectExpression") {
    result.galleries.push(literal(property(colors as ObjectExpression, "initial"), source));
  }
  const members = property(object, "dimensionValuesDisplayData");
  if (members) {
    result.families.push({
      parentAsin: literal(property(object, "parentAsin"), source),
      dimensions: literal(property(object, "dimensions"), source),
      members: literal(members, source),
    });
  }
}

/** Read the two product data objects, preserving all dimension labels instead of only the first. */
export function amazonScriptData(document: AmazonDocument): ScriptData {
  const result: ScriptData = { galleries: [], families: [], warnings: [] };
  for (const script of document.querySelectorAll("script")) {
    const source = script.textContent ?? "";
    if (!/colorImages|dimensionValuesDisplayData/.test(source)) {
      continue;
    }
    try {
      simple(parse(source, { ecmaVersion: "latest" }), {
        ObjectExpression: (object) => collect(object, source, result),
      });
    } catch {
      // Broken embedded data is not evidence. DOM fallbacks remain usable and the
      // omission is explicit.
      result.warnings.push("AMAZON.SCRIPT_DATA_UNREADABLE");
    }
  }
  return { ...result, warnings: [...new Set(result.warnings)] };
}
