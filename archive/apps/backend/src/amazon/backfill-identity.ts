import type { ProductVariant } from "../product-unify.js";

export const VARIANT_DIMENSIONS = ["edition", "flavor", "form", "pack", "servings", "size", "strength"] as const;
type VariantDimension = typeof VARIANT_DIMENSIONS[number];
type Quantity = { value: number; unit: string };

export interface NormalizedBackfillVariant {
  edition?: string;
  flavor?: string;
  form?: string;
  pack?: number;
  servings?: number;
  size?: Quantity;
  strength?: Quantity;
}

export function identityToken(raw: string) {
  return raw.replace(/[®™©]/g, "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

export function normalizeBackfillBaseName(raw: string, brandTokens: string[] = []) {
  let value = identityToken(raw);
  for (const brand of brandTokens) {
    const token = identityToken(brand);
    if (!token || value === token) continue;
    if (value.startsWith(`${token}_`)) {
      value = value.slice(token.length + 1);
      break;
    }
  }
  return value || null;
}

const FORM: Record<string, string> = {
  capsule: "capsule", capsules: "capsule", cap: "capsule", caps: "capsule", vcap: "capsule", vcaps: "capsule",
  veggie_capsule: "capsule", veggie_capsules: "capsule", vegetarian_capsule: "capsule", vegetarian_capsules: "capsule",
  tablet: "tablet", tablets: "tablet", tab: "tablet", tabs: "tablet", caplet: "tablet", caplets: "tablet",
  softgel: "softgel", softgels: "softgel", soft_gel: "softgel", soft_gels: "softgel",
  gummy: "gummy", gummies: "gummy", chewable: "chewable", chewables: "chewable",
  chewable_tablet: "chewable", chewable_tablets: "chewable", powder: "powder", powders: "powder",
  liquid: "liquid", liquids: "liquid", tincture: "liquid", drop: "liquid", drops: "liquid", oil: "oil",
  spray: "spray", lozenge: "lozenge", lozenges: "lozenge", stick_pack: "stick_pack", stick_packs: "stick_pack",
  sachet: "sachet", sachets: "sachet", packet: "sachet", packets: "sachet", soft_chew: "soft_chew",
  soft_chews: "soft_chew", softchew: "soft_chew", softchews: "soft_chew", tea: "tea", bar: "bar", bars: "bar",
  pellet: "pellet", pellets: "pellet", gel: "gel", cream: "cream",
};
const SIZE_UNIT: Record<string, [string, number]> = {
  g: ["g", 1], gram: ["g", 1], grams: ["g", 1], kg: ["g", 1000], kilogram: ["g", 1000], kilograms: ["g", 1000],
  oz: ["g", 28.349523125], ounce: ["g", 28.349523125], ounces: ["g", 28.349523125], lb: ["g", 453.59237],
  lbs: ["g", 453.59237], pound: ["g", 453.59237], pounds: ["g", 453.59237], ml: ["ml", 1],
  milliliter: ["ml", 1], milliliters: ["ml", 1], millilitre: ["ml", 1], millilitres: ["ml", 1],
  l: ["ml", 1000], liter: ["ml", 1000], liters: ["ml", 1000], litre: ["ml", 1000], litres: ["ml", 1000],
  fl_oz: ["ml", 29.5735295625], floz: ["ml", 29.5735295625], fluid_ounce: ["ml", 29.5735295625], fluid_ounces: ["ml", 29.5735295625],
  count: ["count", 1], ct: ["count", 1], piece: ["count", 1], pieces: ["count", 1], pcs: ["count", 1],
  capsule: ["count", 1], capsules: ["count", 1], cap: ["count", 1], caps: ["count", 1], tablet: ["count", 1],
  tablets: ["count", 1], tab: ["count", 1], tabs: ["count", 1], softgel: ["count", 1], softgels: ["count", 1],
  gummy: ["count", 1], gummies: ["count", 1], packet: ["count", 1], packets: ["count", 1], stick: ["count", 1],
  sticks: ["count", 1], sachet: ["count", 1], sachets: ["count", 1], lozenge: ["count", 1], lozenges: ["count", 1],
  chew: ["count", 1], chews: ["count", 1],
};
const STRENGTH_UNIT: Record<string, [string, number]> = {
  mg: ["mg", 1], milligram: ["mg", 1], milligrams: ["mg", 1], g: ["mg", 1000], gram: ["mg", 1000], grams: ["mg", 1000],
  mcg: ["mg", .001], "µg": ["mg", .001], "μg": ["mg", .001], ug: ["mg", .001], microgram: ["mg", .001],
  micrograms: ["mg", .001], iu: ["iu", 1], cfu: ["cfu", 1], billion_cfu: ["cfu", 1e9], billion: ["cfu", 1e9], million_cfu: ["cfu", 1e6],
};

function quantity(value: unknown, units: Record<string, [string, number]>): Quantity | null {
  let amount: number;
  let unit: string;
  if (typeof value === "string") {
    const match = value.normalize("NFKD").replace(/[̀-ͯ]/g, "").trim().toLowerCase()
      .match(/^(\d+(?:,\d{3})*(?:\.\d+)?)\s*([a-zµμ][a-zµμ_ .]*?)\.?$/);
    if (!match) return null;
    amount = Number(match[1]!.replace(/,/g, ""));
    unit = match[2]!.trim().replace(/[ .]+/g, "_");
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as { value?: unknown; unit?: unknown };
    amount = Number(raw.value);
    unit = identityToken(String(raw.unit ?? ""));
  } else return null;
  const conversion = units[unit];
  return conversion && Number.isFinite(amount) && amount > 0 ? { value: amount * conversion[1], unit: conversion[0] } : null;
}

function integer(value: unknown, kind: "pack" | "servings") {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  const raw = String(value ?? "").trim().toLowerCase();
  const match = kind === "pack"
    ? raw.match(/^pack\s*of\s*(\d+)$/) ?? raw.match(/^(\d+)\s*[- ]?\s*(pack|pk|ct\s*pack|packs)$/) ?? raw.match(/^(\d+)$/)
    : raw.match(/^(\d+)\s*(servings?|serv|svg)?\.?$/);
  return match && Number(match[1]) > 0 ? Number(match[1]) : null;
}

const supplied = (value: unknown) => value !== null && value !== undefined && !(typeof value === "string" && !value.trim());
const format = (value: number) => (Math.round(value * 1000) / 1000).toFixed(3);

export function normalizeBackfillVariant(input: ProductVariant) {
  const attrs: NormalizedBackfillVariant = {};
  const unresolved: VariantDimension[] = [];
  if (supplied(input.edition)) attrs.edition = identityToken(String(input.edition));
  if (supplied(input.flavor)) attrs.flavor = identityToken(String(input.flavor)).replace(/^(flavou?r(ed)?_)+/, "").replace(/(_flavou?r(ed)?)+$/, "");
  if (supplied(input.form)) {
    const value = FORM[identityToken(String(input.form))];
    if (value) attrs.form = value; else unresolved.push("form");
  }
  if (supplied(input.pack)) { const value = integer(input.pack, "pack"); if (value) attrs.pack = value; else unresolved.push("pack"); }
  if (supplied(input.servings)) { const value = integer(input.servings, "servings"); if (value) attrs.servings = value; else unresolved.push("servings"); }
  if (supplied(input.size)) { const value = quantity(input.size, SIZE_UNIT); if (value) attrs.size = value; else unresolved.push("size"); }
  if (supplied(input.strength)) { const value = quantity(input.strength, STRENGTH_UNIT); if (value) attrs.strength = value; else unresolved.push("strength"); }
  const parts = unresolved.length ? [] : VARIANT_DIMENSIONS.flatMap((dimension) => {
    const value = attrs[dimension];
    if (value === undefined) return [];
    return [`${dimension}=${typeof value === "object" ? `${format(value.value)}${value.unit}` : value}`];
  });
  return { attrs, key: parts.length ? parts.join("|") : null, unresolved };
}
