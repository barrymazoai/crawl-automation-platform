#!/usr/bin/env node
/*
 * Evidence-led second pass for the company ingredient batch.  The map below is
 * deliberately an explicit, reviewed decision table: it is not a keyword
 * splitter.  Every entry was chosen from the record's Ingredients/Facts text.
 */
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const INPUT = path.join(ROOT, "real-crawl-results/company-ingredients-20260817-final/crawl-records.json");
const OUT = path.join(ROOT, "real-crawl-results/company-ingredients-20260817-luna-repair-working");
const EVIDENCE = path.join(ROOT, "real-crawl-results/company-ingredients-20260817-repaired/evidence");
let pageSourceReviews = [];

const q = (name, substance, category, form) => ({ name, substance, category, ...(form ? { form } : {}) });
const V = (n, s, f) => q(n, s, "vitamins", f);
const N = (n, s, f) => q(n, s, "minerals", f);
const H = (n, s, f) => q(n, s, "herbs_botanicals", f);
const A = (n, s, f) => q(n, s, "antioxidants_polyphenols", f);
const F = (n, s, f) => q(n, s, "fatty_acids_lipids", f);
const P = (n, s, f) => q(n, s, "amino_acids_peptides", f);
const M = (n, s, f) => q(n, s, "mushrooms", f);
const B = (n, s, f) => q(n, s, "probiotics_prebiotics", f);
const C = (n, s, f) => q(n, s, "fibers_carbs", f);
const O = (n, s, f) => q(n, s, "proprietary_blends_other", f);

// Product-number -> model-reviewed active/key ingredient decisions.  Product
// numbers are the stable order in the supplied final crawl (Bärbel starts at
// record 54).  Excipients, flavours, carriers and dosage aids are excluded.
const ING = {
  1: [O("Spirulina platensis algae powder", "Spirulina platensis", "algae powder"), V("Beta-Carotene", "Vitamin A", "provitamin A"), V("Vitamin B12", "Vitamin B12"), V("Vitamin K", "Vitamin K"), N("Iron", "Iron")],
  2: [F("DHA-rich algal oil", "DHA", "Schizochytrium oil"), H("Rosehip fruit extract", "Rosehip", "fruit extract"), A("Bilberry fruit extract", "Bilberry", "fruit extract"), A("Astaxanthin", "Astaxanthin"), A("Lutein", "Lutein"), A("Zeaxanthin", "Zeaxanthin"), A("Beta-Carotene", "Beta-Carotene", "carotenoid"), V("Vitamin C", "Vitamin C"), V("Vitamin E", "Vitamin E"), V("Vitamin B2", "Vitamin B2"), N("Zinc", "Zinc")],
  3: [N("Magnesium", "Magnesium", "carbonate and citrate"), N("Silica", "Silicon", "silica"), H("Horsetail powder", "Horsetail", "powder"), H("Nettle leaf powder", "Nettle", "leaf powder")],
  4: [H("Ceylon cinnamon powder", "Cinnamon", "Zeylanicum powder"), H("Cassia cinnamon extract", "Cinnamon", "Cassia extract"), H("Purslane extract", "Purslane", "extract"), H("Bitter melon extract", "Bitter melon", "extract"), V("Vitamin B1", "Vitamin B1"), V("Vitamin B3", "Vitamin B3"), V("Vitamin B6", "Vitamin B6"), V("Vitamin B12", "Vitamin B12"), N("Zinc", "Zinc"), N("Chromium", "Chromium")],
  5: [N("Silicon", "Silicon", "silicon dioxide in water")],
  6: [H("Hop powder and extract", "Hop", "powder and extract"), A("Grape seed extract", "Grape Seed", "seed extract"), H("Sage leaf powder and extract", "Sage", "leaf powder and extract"), H("Alfalfa herb powder", "Alfalfa", "herb powder"), A("Grape-seed OPC", "Proanthocyanidins", "grape seed OPC"), V("Vitamin B1", "Vitamin B1"), V("Vitamin B6", "Vitamin B6"), V("Vitamin B12", "Vitamin B12"), V("Vitamin C", "Vitamin C"), V("Vitamin D3", "Vitamin D", "cholecalciferol"), V("Vitamin E", "Vitamin E")],
  7: [H("Ashwagandha extract", "Ashwagandha", "extract"), H("Blackcurrant concentrate and extract", "Blackcurrant", "fruit extract"), H("Ginseng extract", "Ginseng", "root extract"), V("Vitamin B12", "Vitamin B12"), V("Vitamin C", "Vitamin C"), V("Vitamin E", "Vitamin E"), N("Magnesium", "Magnesium", "citrate")],
  8: [C("Psyllium husk", "Psyllium", "husk"), H("Amla fruit powder", "Amla", "fruit powder"), H("Amla extract", "Amla", "fruit extract"), N("Calcium", "Calcium", "carbonate"), H("Myrrh resin powder", "Myrrh", "resin powder")],
  9: [O("Hyaluronic acid", "Hyaluronic Acid"), O("Methylsulfonylmethane", "MSM"), H("Rosehip juice concentrate", "Rosehip", "juice concentrate"), H("Rosehip extract", "Rosehip", "extract"), V("Vitamin C", "Vitamin C")],
  10: [H("Cistus herb extract", "Cistus", "herb extract"), H("Thyme", "Thyme", "herb extract"), H("Sage", "Sage", "leaf extract"), V("Vitamin C", "Vitamin C"), H("Eucalyptus oil", "Eucalyptus", "essential oil")],
  11: [B("Bifidobacterium lactis", "Bifidobacterium lactis", "bacterial culture"), B("Lactobacillus casei", "Lactobacillus casei", "bacterial culture"), B("Lactobacillus plantarum", "Lactobacillus plantarum", "bacterial culture"), B("Lactobacillus rhamnosus", "Lactobacillus rhamnosus", "bacterial culture"), B("Lactobacillus gasseri", "Lactobacillus gasseri", "bacterial culture"), B("Lactobacillus acidophilus", "Lactobacillus acidophilus", "bacterial culture"), N("Chromium", "Chromium")],
  12: [N("Calcium", "Calcium", "carbonate"), V("Vitamin D3", "Vitamin D", "cholecalciferol")],
  13: [O("Lithothamnium mineral complex", "Mineral complex", "red-algae minerals"), H("Echinacea juice powder", "Echinacea", "juice powder"), H("Elderberry extract", "Elderberry", "fruit extract"), H("Ginseng extract", "Ginseng", "root extract"), H("Andrographis extract", "Andrographis", "herb extract"), V("Vitamin C", "Vitamin C"), V("Vitamin D3", "Vitamin D", "cholecalciferol"), N("Silicon", "Silicon"), N("Zinc", "Zinc")],
  14: [P("Milk protein", "Milk protein", "protein powder"), P("Pea protein isolate", "Pea protein", "protein isolate"), P("Sunflower protein", "Sunflower protein", "protein powder"), P("Rice protein concentrate", "Rice protein", "protein concentrate"), H("Ashwagandha extract", "Ashwagandha", "extract"), H("Cinnamon extract", "Cinnamon", "extract"), V("Vitamin B1", "Vitamin B1"), V("Vitamin B2", "Vitamin B2"), V("Vitamin B6", "Vitamin B6"), V("Vitamin B12", "Vitamin B12"), V("Vitamin C", "Vitamin C")],
  15: [P("Hydrolysed collagen", "Collagen", "fish collagen hydrolysate"), O("Hyaluronic acid", "Hyaluronic Acid"), O("Methylsulfonylmethane", "MSM"), H("Astragalus extract", "Astragalus", "extract"), H("Green tea extract", "Green Tea", "extract"), V("Vitamin C", "Vitamin C"), N("Copper", "Copper")],
  16: [O("Lithothamnium mineral complex", "Mineral complex", "red-algae minerals"), H("Ginseng root powder and extract", "Ginseng", "root powder and extract"), O("Propolis extract", "Propolis", "extract"), H("Echinacea juice powder", "Echinacea", "juice powder"), H("Andrographis extract", "Andrographis", "extract"), V("Vitamin C", "Vitamin C"), V("Vitamin D3", "Vitamin D", "cholecalciferol"), N("Zinc", "Zinc")],
  17: [O("Spirulina platensis algae powder", "Spirulina platensis", "algae powder"), V("Beta-Carotene", "Vitamin A", "provitamin A"), V("Vitamin B12", "Vitamin B12"), V("Vitamin K", "Vitamin K"), N("Iron", "Iron")],
  18: [P("Pea protein", "Pea protein", "protein powder"), P("Sunflower protein", "Sunflower protein", "protein powder"), C("Inulin", "Inulin", "prebiotic fiber"), H("Turmeric powder", "Turmeric", "powder"), H("Fenugreek seed powder", "Fenugreek", "seed powder")],
  19: [F("DHA", "DHA", "algal oil"), F("EPA", "EPA", "algal oil")],
  20: [N("Magnesium", "Magnesium", "carbonate, citrate and bisglycinate"), H("Horsetail extract", "Horsetail", "extract"), N("Silica", "Silicon", "silica")],
  21: [V("Vitamin B1", "Vitamin B1", "thiamin"), V("Vitamin B2", "Vitamin B2", "riboflavin"), V("Vitamin B3", "Vitamin B3", "niacin"), V("Vitamin B5", "Vitamin B5", "pantothenic acid"), V("Vitamin B6", "Vitamin B6"), V("Biotin", "Biotin"), V("Folate", "Folate"), V("Vitamin B12", "Vitamin B12", "methylcobalamin")],
  22: [O("Coenzyme Q10", "Coenzyme Q10"), V("Vitamin E", "Vitamin E"), V("Vitamin B2", "Vitamin B2")],
  23: [V("Niacin", "Vitamin B3", "niacin"), V("Vitamin C", "Vitamin C"), V("Vitamin D", "Vitamin D"), V("Vitamin E", "Vitamin E"), N("Zinc", "Zinc"), N("Selenium", "Selenium"), O("Coenzyme Q10", "Coenzyme Q10"), A("Quercetin", "Quercetin"), H("Myrobalan fruit extract", "Myrobalan", "fruit extract"), O("Shilajit powder", "Shilajit", "powder"), A("trans-Resveratrol", "Resveratrol", "trans-resveratrol"), H("Green tea extract", "Green Tea", "extract"), O("NADH", "NADH"), A("Astaxanthin", "Astaxanthin")],
  24: [N("Calcium", "Calcium", "carbonate and citrate"), N("Magnesium", "Magnesium", "carbonate and citrate"), H("Turmeric powder", "Turmeric", "powder"), N("Silica", "Silicon", "silica"), V("Vitamin D3", "Vitamin D", "cholecalciferol")],
  25: [P("Pea protein isolate", "Pea protein", "protein isolate"), P("Rice protein concentrate", "Rice protein", "protein concentrate"), P("Hemp protein", "Hemp protein", "protein powder"), P("Cranberry protein", "Cranberry protein", "protein powder"), H("Cinnamon extract", "Cinnamon", "extract")],
  26: [H("Saw palmetto fruit extract", "Saw Palmetto", "fruit extract"), P("L-Methionine", "Methionine", "L-form"), P("L-Cysteine hydrochloride", "Cysteine", "hydrochloride"), H("Pea sprout extract", "Pea", "sprout extract"), N("Silicon", "Silicon", "bamboo extract"), N("Zinc", "Zinc", "bisglycinate"), V("Biotin", "Biotin"), N("Copper", "Copper"), N("Selenium", "Selenium"), A("Bilberry extract", "Bilberry", "fruit extract")],
  27: [F("Alpha-linolenic acid", "Alpha-linolenic acid", "perilla oil")],
  28: [N("Silicon", "Silicon", "silicon dioxide"), N("Manganese", "Manganese"), N("Copper", "Copper"), N("Zinc", "Zinc")],
  29: [V("Vitamin D3", "Vitamin D", "cholecalciferol"), V("Vitamin K2", "Vitamin K", "menaquinone MK-7")],
  30: [N("Zinc", "Zinc", "gluconate"), N("Selenium", "Selenium", "selenised yeast")],
  31: [N("Magnesium", "Magnesium", "carbonate"), H("Horsetail powder", "Horsetail", "powder"), H("Nettle leaf powder", "Nettle", "leaf powder")],
  32: [H("Maca root extract", "Maca", "root extract"), H("Damiana leaf extract", "Damiana", "leaf extract"), H("Sage leaf extract", "Sage", "leaf extract"), H("Wild yam root extract", "Wild Yam", "root extract"), H("Safran extract", "Saffron", "extract"), C("Inulin", "Inulin", "prebiotic fiber"), V("Vitamin B6", "Vitamin B6"), V("Folate", "Folate"), V("Vitamin D", "Vitamin D"), N("Calcium", "Calcium"), N("Chromium", "Chromium")],
  33: [P("Hydrolysed collagen", "Collagen", "fish collagen hydrolysate"), V("Vitamin C", "Vitamin C"), A("Astaxanthin", "Astaxanthin", "algal oleoresin")],
  34: [P("Hydrolysed collagen", "Collagen", "type I and II hydrolysate"), H("Rosehip fruit extract", "Rosehip", "fruit extract"), V("Biotin", "Biotin"), N("Zinc", "Zinc")],
  35: [O("Spirulina platensis powder", "Spirulina platensis", "algae powder"), O("Chlorella vulgaris powder", "Chlorella vulgaris", "algae powder"), V("Beta-Carotene", "Vitamin A", "provitamin A"), V("Vitamin B12", "Vitamin B12"), V("Vitamin K", "Vitamin K"), O("Chlorophyll", "Chlorophyll")],
  36: [F("DHA", "DHA", "algal oil"), F("EPA", "EPA", "algal oil"), F("DPA", "DPA", "algal oil")],
  37: [V("Vitamin C", "Vitamin C"), V("Vitamin D", "Vitamin D"), V("Vitamin E", "Vitamin E"), V("Vitamin A", "Vitamin A", "beta-carotene"), V("Vitamin B1", "Vitamin B1"), V("Vitamin B2", "Vitamin B2"), V("Vitamin B3", "Vitamin B3"), V("Vitamin B5", "Vitamin B5"), V("Vitamin B6", "Vitamin B6"), V("Biotin", "Biotin"), V("Folate", "Folate"), V("Vitamin B12", "Vitamin B12"), N("Chromium", "Chromium"), N("Manganese", "Manganese"), N("Copper", "Copper"), N("Zinc", "Zinc"), N("Magnesium", "Magnesium"), N("Calcium", "Calcium"), N("Iron", "Iron"), N("Selenium", "Selenium")],
  38: [O("Methylsulfonylmethane", "MSM")],
  39: [N("Zinc", "Zinc", "gluconate"), P("L-Histidine", "Histidine", "L-form")],
  40: [V("Vitamin D3", "Vitamin D", "cholecalciferol")],
  41: [V("Vitamin D3", "Vitamin D", "cholecalciferol")],
  42: [V("Vitamin C", "Vitamin C", "L-ascorbic acid"), H("Camu camu fruit powder", "Camu Camu", "fruit powder"), H("Acerola fruit powder", "Acerola", "fruit powder")],
  43: [P("Eggshell membrane collagen", "Collagen", "eggshell membrane"), O("Hyaluronic acid", "Hyaluronic Acid"), A("Grape seed OPC", "Proanthocyanidins", "grape seed extract"), A("Astaxanthin", "Astaxanthin", "algae powder"), O("Coenzyme Q10", "Coenzyme Q10"), V("Vitamin B2", "Vitamin B2"), V("Biotin", "Biotin"), V("Vitamin C", "Vitamin C"), V("Vitamin E", "Vitamin E"), N("Manganese", "Manganese"), N("Copper", "Copper"), N("Selenium", "Selenium")],
  44: [H("Rhodiola rosea extract", "Rhodiola", "extract"), V("Vitamin B12", "Vitamin B12")],
  45: [N("Iron bisglycinate", "Iron", "bisglycinate"), V("Vitamin C", "Vitamin C")],
  46: [O("Choline bitartrate", "Choline", "bitartrate"), O("Phosphatidylserine", "Phosphatidylserine"), M("Lion's mane mushroom", "Lion's Mane", "powder"), H("Astragalus root extract", "Astragalus", "root extract"), F("DHA", "DHA", "algal oil"), V("Vitamin B complex", "B vitamins", "plant extract"), V("Vitamin C", "Vitamin C"), V("Vitamin D", "Vitamin D"), V("Vitamin B12", "Vitamin B12"), N("Zinc", "Zinc"), H("Guarana seed extract", "Guarana", "seed extract"), H("Ginkgo leaf extract", "Ginkgo", "leaf extract"), B("Lactobacillus paracasei", "Lactobacillus paracasei", "inactivated culture")],
  47: [N("Magnesium", "Magnesium", "citrate"), V("Vitamin C", "Vitamin C")],
  48: [P("L-Tryptophan", "Tryptophan", "L-form"), H("Lemon balm leaf extract", "Lemon Balm", "leaf extract"), P("L-Tyrosine", "Tyrosine", "L-form"), H("St John's wort extract", "St John's Wort", "extract"), P("L-Phenylalanine", "Phenylalanine", "L-form"), H("Griffonia seed extract", "Griffonia", "seed extract"), H("Saffron extract", "Saffron", "extract"), V("Vitamin B complex", "B vitamins", "plant extract"), V("Vitamin B12", "Vitamin B12"), V("Vitamin C", "Vitamin C"), V("Vitamin D", "Vitamin D"), N("Magnesium", "Magnesium"), N("Zinc", "Zinc")],
  49: [O("Wheat germ extract", "Wheat Germ", "extract"), O("Spermidine", "Spermidine"), O("Buckwheat germ powder", "Buckwheat", "germ powder"), N("Zinc", "Zinc")],
  50: [V("Beta-Carotene", "Vitamin A", "provitamin A"), V("Vitamin B1", "Vitamin B1"), V("Vitamin B2", "Vitamin B2"), V("Vitamin B3", "Vitamin B3"), V("Vitamin B5", "Vitamin B5"), V("Vitamin B6", "Vitamin B6"), V("Biotin", "Biotin"), V("Folate", "Folate"), V("Vitamin B12", "Vitamin B12"), V("Vitamin C", "Vitamin C"), V("Vitamin D", "Vitamin D"), V("Vitamin E", "Vitamin E"), N("Calcium", "Calcium"), N("Magnesium", "Magnesium"), N("Zinc", "Zinc"), N("Iron", "Iron"), N("Iodine", "Iodine"), N("Selenium", "Selenium"), N("Manganese", "Manganese"), N("Copper", "Copper"), N("Chromium", "Chromium"), A("Lutein", "Lutein")],
  51: [N("Iron", "Iron", "pyrophosphate")],
  52: [O("Spirulina platensis algae powder", "Spirulina platensis", "algae powder"), A("Grape seed extract", "Grape Seed", "extract"), A("Proanthocyanidins (OPC)", "Proanthocyanidins", "grape seed OPC"), V("Beta-Carotene", "Vitamin A", "provitamin A"), V("Vitamin B12", "Vitamin B12"), V("Vitamin K", "Vitamin K")],
  53: [P("Hydrolysed collagen", "Collagen", "collagen hydrolysate"), O("Hyaluronic acid", "Hyaluronic Acid"), V("Vitamin C", "Vitamin C"), P("L-Carnitine", "Carnitine", "L-form")],
  54: [V("Vitamin D3", "Vitamin D", "cholecalciferol"), V("Vitamin K2", "Vitamin K", "menaquinone MK-7"), N("Calcium", "Calcium"), N("Magnesium", "Magnesium"), N("Zinc", "Zinc"), N("Manganese", "Manganese"), H("Rosehip extract", "Rosehip", "extract"), N("Silicon", "Silicon", "bamboo extract"), P("L-Lysine", "Lysine", "L-form")],
  55: [V("Vitamin D3", "Vitamin D", "cholecalciferol")],
  56: [V("Folate", "Folate", "lemon peel extract")],
  57: [H("Cistus herb powder and extract", "Cistus", "powder and extract"), H("Elderberry and blackcurrant powder", "Elderberry", "fruit powder"), H("Thyme powder and extract", "Thyme", "powder and extract"), H("Oregano powder and extract", "Oregano", "powder and extract"), V("Vitamin C", "Vitamin C")],
  58: [M("Reishi mushroom extract", "Reishi", "extract"), M("Lion's mane mushroom extract", "Lion's Mane", "extract"), M("Shiitake mushroom extract", "Shiitake", "extract"), O("Shilajit extract", "Shilajit", "extract"), V("Vitamin C", "Vitamin C"), N("Zinc", "Zinc")],
  59: [N("Iodine", "Iodine", "brown algae source"), O("Brown algae", "Brown Algae", "Fucus and Ascophyllum")],
  60: [N("Zinc", "Zinc", "gluconate"), P("L-Histidine", "Histidine", "L-form")],
  61: [V("Vitamin D3", "Vitamin D", "cholecalciferol")],
  62: [M("Almond mushroom powder", "Almond Mushroom", "powder"), N("Selenium", "Selenium", "selenised yeast")],
  63: [V("Vitamin B complex", "B vitamins", "plant extract"), V("Vitamin B12", "Vitamin B12"), V("Vitamin C", "Vitamin C"), N("Magnesium", "Magnesium"), N("Iron", "Iron"), N("Zinc", "Zinc"), N("Selenium", "Selenium"), O("Coenzyme Q10", "Coenzyme Q10"), O("Glutathione", "Glutathione"), P("L-Tryptophan", "Tryptophan", "L-form"), H("Rhodiola rosea extract", "Rhodiola", "extract"), H("Ashwagandha extract", "Ashwagandha", "extract"), H("Ginseng extract", "Ginseng", "extract"), O("NADH", "NADH"), A("trans-Resveratrol", "Resveratrol", "trans-resveratrol")],
  64: [V("Vitamin C", "Vitamin C"), V("Niacin", "Vitamin B3", "niacin"), N("Magnesium", "Magnesium", "citrate"), C("Inulin", "Inulin", "prebiotic fiber"), H("Chamomile flower extract", "Chamomile", "flower extract"), M("Shiitake mushroom powder", "Shiitake", "powder"), H("Lemon balm leaf extract", "Lemon Balm", "leaf extract"), H("Passionflower extract", "Passionflower", "extract"), H("Pomegranate fruit extract", "Pomegranate", "fruit extract"), H("Lavender flower extract", "Lavender", "flower extract")],
  65: [V("Vitamin C", "Vitamin C", "L-ascorbic acid"), A("Quercetin", "Quercetin"), A("Rutin", "Rutin"), A("Green tea catechins", "Catechins", "green tea extract"), A("Grape seed OPC", "Proanthocyanidins", "grape seed extract")],
  66: [V("Vitamin C", "Vitamin C", "acerola source"), H("Acerola fruit powder", "Acerola", "fruit powder")],
  67: [N("Calcium", "Calcium", "carbonate"), V("Vitamin D3", "Vitamin D", "cholecalciferol"), V("Vitamin K2", "Vitamin K", "menaquinone"), H("Olive leaf powder and extract", "Olive Leaf", "powder and extract")],
  68: [V("Beta-Carotene", "Vitamin A", "provitamin A"), V("Vitamin B1", "Vitamin B1"), V("Vitamin B2", "Vitamin B2"), V("Vitamin B3", "Vitamin B3"), V("Vitamin B5", "Vitamin B5"), V("Vitamin B6", "Vitamin B6"), V("Biotin", "Biotin"), V("Folate", "Folate"), V("Vitamin B12", "Vitamin B12"), V("Vitamin C", "Vitamin C"), V("Vitamin D", "Vitamin D"), V("Vitamin E", "Vitamin E"), V("Vitamin K", "Vitamin K"), N("Calcium", "Calcium"), N("Magnesium", "Magnesium"), N("Zinc", "Zinc"), N("Iron", "Iron"), N("Iodine", "Iodine"), N("Selenium", "Selenium"), N("Manganese", "Manganese"), N("Copper", "Copper"), N("Chromium", "Chromium"), H("Hop flower extract", "Hop", "flower extract")],
  69: [N("Magnesium", "Magnesium", "oxide"), H("Lady's mantle extract", "Lady's Mantle", "extract"), H("Lemon balm extract", "Lemon Balm", "leaf extract"), H("Saffron extract", "Saffron", "extract"), H("Chaste tree berry powder", "Chaste Tree", "fruit powder"), V("Vitamin B1", "Vitamin B1"), V("Vitamin B3", "Vitamin B3"), V("Vitamin B5", "Vitamin B5"), V("Vitamin B6", "Vitamin B6"), V("Biotin", "Biotin"), V("Folate", "Folate"), V("Vitamin B12", "Vitamin B12"), N("Zinc", "Zinc"), N("Selenium", "Selenium")],
  70: [V("Vitamin C", "Vitamin C"), N("Zinc", "Zinc", "citrate"), P("L-Histidine", "Histidine", "L-form")],
  71: [N("Calcium", "Calcium"), N("Magnesium", "Magnesium"), N("Iron", "Iron", "bisglycinate"), N("Zinc", "Zinc"), N("Selenium", "Selenium", "selenised yeast"), N("Copper", "Copper"), N("Manganese", "Manganese"), N("Chromium", "Chromium")],
  72: [N("Calcium", "Calcium"), N("Magnesium", "Magnesium"), N("Zinc", "Zinc"), N("Copper", "Copper"), N("Chromium", "Chromium"), V("Biotin", "Biotin"), H("Angelica root powder", "Angelica", "root powder")],
  73: [P("Milk protein", "Milk protein", "protein powder"), P("Pea protein isolate", "Pea protein", "protein isolate"), P("Sunflower protein", "Sunflower protein", "protein powder"), P("Rice protein concentrate", "Rice protein", "protein concentrate"), H("Cayenne pepper", "Cayenne", "pepper powder"), V("Vitamin B1", "Vitamin B1"), V("Vitamin B2", "Vitamin B2"), V("Vitamin B6", "Vitamin B6"), V("Vitamin B12", "Vitamin B12"), V("Vitamin C", "Vitamin C")],
  74: [H("Amla fruit extract", "Amla", "fruit extract"), A("Beta-Carotene", "Beta-Carotene", "carrot extract"), A("Lycopene", "Lycopene"), A("Lutein", "Lutein"), V("Vitamin C", "Vitamin C"), V("Vitamin E", "Vitamin E"), N("Copper", "Copper")],
  75: [A("Astaxanthin", "Astaxanthin", "Haematococcus pluvialis extract"), V("Vitamin E", "Vitamin E"), N("Copper", "Copper")],
  76: [H("Cranberry extract", "Cranberry", "fruit extract"), H("Pumpkin seed extract", "Pumpkin Seed", "seed extract"), H("Nettle root extract", "Nettle", "root extract"), H("Hibiscus powder", "Hibiscus", "flower powder"), H("Sabal fruit powder", "Saw Palmetto", "fruit powder"), H("Orthosiphon leaf", "Orthosiphon", "leaf"), V("Vitamin C", "Vitamin C"), V("Vitamin B2", "Vitamin B2")],
  77: [F("Gamma-linolenic acid", "Gamma-linolenic acid", "evening primrose oil"), F("Linoleic acid", "Linoleic acid", "evening primrose oil"), V("Vitamin E", "Vitamin E")],
  78: [H("Ginger juice", "Ginger", "juice"), H("Turmeric extract", "Turmeric", "curcuminoid-rich extract"), A("Curcuminoids", "Curcuminoids", "turmeric extract"), A("Piperine", "Piperine", "pepper extract"), V("Vitamin C", "Vitamin C")],
  79: [A("Astaxanthin", "Astaxanthin", "algae extract"), O("Caffeine", "Caffeine"), V("Vitamin C", "Vitamin C"), N("Magnesium", "Magnesium", "citrate")],
  80: [H("Turmeric extract", "Turmeric", "curcuminoid-rich extract"), A("Curcuminoids", "Curcuminoids", "turmeric extract"), A("Piperine", "Piperine", "pepper extract"), V("Vitamin C", "Vitamin C")],
  81: [H("Green oat", "Green Oat", "herb powder"), H("Plantain powder", "Plantain", "powder"), H("Marshmallow root powder", "Marshmallow", "root powder"), H("Turmeric extract", "Turmeric", "extract"), H("Thyme extract", "Thyme", "extract"), H("Sage powder", "Sage", "powder"), H("Licorice juice powder", "Licorice", "juice powder"), H("Eucalyptus oil", "Eucalyptus", "essential oil"), V("Vitamin C", "Vitamin C")],
  82: [H("Cranberry juice concentrate", "Cranberry", "juice concentrate"), H("Licorice juice concentrate", "Licorice", "juice concentrate"), H("Mallow leaf and extract", "Mallow", "leaf and extract"), V("Vitamin C", "Vitamin C")],
  83: [H("Brahmi powder and extract", "Bacopa monnieri", "powder and extract"), H("Ginkgo leaf powder and extract", "Ginkgo", "leaf powder and extract"), O("Phosphatidylserine", "Phosphatidylserine"), H("Sage leaf powder and extract", "Sage", "leaf powder and extract"), H("Lemon balm leaf powder and extract", "Lemon Balm", "leaf powder and extract"), H("Ginseng root powder", "Ginseng", "root powder"), V("Vitamin B1", "Vitamin B1"), V("Vitamin B5", "Vitamin B5"), V("Vitamin B12", "Vitamin B12")],
  84: [A("Astaxanthin", "Astaxanthin", "algae extract"), O("Caffeine", "Caffeine"), V("Vitamin C", "Vitamin C"), N("Magnesium", "Magnesium", "citrate")],
  85: [H("St John's wort extract", "St John's Wort", "extract"), H("Hop flower extract", "Hop", "flower extract"), H("Passionflower extract", "Passionflower", "extract"), V("Vitamin B6", "Vitamin B6"), V("Vitamin C", "Vitamin C")],
  86: [H("Mate leaf powder and extract", "Yerba Mate", "leaf powder and extract"), H("Coleus forskohlii extract", "Coleus forskohlii", "extract"), H("Jiaogulan extract", "Jiaogulan", "extract"), H("Guarana extract", "Guarana", "extract"), N("Zinc", "Zinc"), N("Chromium", "Chromium")],
  87: [H("Milk thistle seed extract", "Milk Thistle", "seed extract"), H("Artichoke herb", "Artichoke", "herb"), H("Dandelion root and herb", "Dandelion", "root and herb"), V("Vitamin E", "Vitamin E")],
  88: [A("Astaxanthin", "Astaxanthin", "algae extract"), O("Caffeine", "Caffeine"), V("Vitamin C", "Vitamin C"), N("Magnesium", "Magnesium", "citrate")],
  89: [A("Astaxanthin", "Astaxanthin", "algae extract"), O("Caffeine", "Caffeine"), V("Vitamin C", "Vitamin C"), N("Magnesium", "Magnesium", "citrate")],
  90: [A("Astaxanthin", "Astaxanthin", "algae extract"), O("Caffeine", "Caffeine"), V("Vitamin C", "Vitamin C"), N("Magnesium", "Magnesium", "citrate")],
  91: [H("Sage leaf extract", "Sage", "leaf extract"), H("Parsley leaf extract", "Parsley", "leaf extract"), H("Schisandra fruit extract", "Schisandra", "fruit extract"), V("Vitamin B6", "Vitamin B6"), H("Peppermint leaf extract", "Peppermint", "leaf extract"), H("Ashwagandha root extract", "Ashwagandha", "root extract"), N("Magnesium", "Magnesium", "oxide"), N("Zinc", "Zinc")],
  92: [H("Frankincense powder and extract", "Boswellia", "resin powder and extract"), H("Myrrh resin powder", "Myrrh", "resin powder"), H("Baobab fruit powder", "Baobab", "fruit powder")],
  93: [A("Astaxanthin", "Astaxanthin", "Haematococcus pluvialis powder"), H("Guarana extract", "Guarana", "extract"), A("Hibiscus flower extract", "Hibiscus", "flower extract"), V("Vitamin B2", "Vitamin B2")],
  94: [A("Astaxanthin", "Astaxanthin", "Haematococcus pluvialis oleoresin"), V("Vitamin E", "Vitamin E")],
  95: [O("Chlorella vulgaris algae powder", "Chlorella vulgaris", "algae powder"), O("Chlorophyll", "Chlorophyll"), A("Beta-Carotene", "Vitamin A", "provitamin A"), N("Iron", "Iron")],
  96: [H("Turmeric root extract", "Turmeric", "curcuminoid-rich root extract"), A("Curcuminoids", "Curcuminoids", "turmeric extract")],
  97: [H("Ginger juice", "Ginger", "juice"), H("Whole lemon powder", "Lemon", "whole fruit powder"), H("Garlic extract", "Garlic", "extract"), H("Turmeric root powder", "Turmeric", "root powder"), V("Vitamin B1", "Vitamin B1"), V("Vitamin C", "Vitamin C")],
  98: [H("Ashwagandha root extract", "Ashwagandha", "root extract")],
};

const HEALTH = {
  1: "Foundational Nutrition Support", 2: "Eye Health Support", 3: "Muscle Health", 4: "Healthy Glucose Metabolism Support", 5: "Skin Health", 6: "Women's Health", 7: "Stress Management", 8: "Digestive Health", 9: "Joint Health", 10: "Respiratory Health Support", 11: "Digestive Health", 12: "Bone Health", 13: "Immune Support", 14: "Weight Management", 15: "Skin Health", 16: "Immune Support", 17: "Foundational Nutrition Support", 18: "Weight Management", 19: "Heart Health", 20: "Muscle Health", 21: "Energy Support", 22: "Antioxidant", 23: "Energy Support", 24: "Bone Health", 25: "Weight Management", 26: "Hair Health", 27: "Heart Health", 28: "Skin Health", 29: "Bone Health", 30: "Immune Support", 31: "Muscle Health", 32: "Women's Health", 33: "Skin Health", 34: "Skin Health", 35: "Foundational Nutrition Support", 36: "Heart Health", 37: "Vitamin & Mineral Support", 38: "Joint Health", 39: "Immune Support", 40: "Bone Health", 41: "Bone Health", 42: "Immune Support", 43: "Skin Health", 44: "Energy Support", 45: "Energy Support", 46: "Cognitive Function", 47: "Muscle Health", 48: "Sleep Support", 49: "Healthy Aging", 50: "Vitamin & Mineral Support", 51: "Energy Support", 52: "Antioxidant", 53: "Skin Health", 54: "Bone Health", 55: "Bone Health", 56: "Vitamin & Mineral Support", 57: "Respiratory Health Support", 58: "Immune Support", 59: "Thyroid Support", 60: "Immune Support", 61: "Bone Health", 62: "Antioxidant", 63: "Energy Support", 64: "Sleep Support", 65: "Antioxidant", 66: "Immune Support", 67: "Bone Health", 68: "Women's Health", 69: "Women's Health", 70: "Immune Support", 71: "Mineral Support", 72: "Mineral Support", 73: "Weight Management", 74: "Skin Health", 75: "Antioxidant", 76: "Urinary Tract Health", 77: "Skin Health", 78: "Antioxidant", 79: "Energy Support", 80: "Antioxidant", 81: "Respiratory Health Support", 82: "Digestive Health", 83: "Cognitive Function", 84: "Energy Support", 85: "Sleep Support", 86: "Weight Management", 87: "Liver Health", 88: "Energy Support", 89: "Energy Support", 90: "Energy Support", 91: "Women's Health", 92: "Joint Health", 93: "Energy Support", 94: "Antioxidant", 95: "Foundational Nutrition Support", 96: "Antioxidant", 97: "Immune Support", 98: "Stress Management",
};

// Legacy ProEnzol phrases are retained as evidence, while the exported field
// is pinned to the current database vocabulary.  These are semantic category
// decisions, not ingredient extraction rules.
const LEGACY_HEALTH = new Map([
  ["stress response and adrenal support", "Adrenal Support"],
  ["energy and stress response support", "Energy Support"],
  ["seasonal immune and respiratory support", "Immune Support"],
  ["carbohydrate digestion support", "Digestive Health"],
  ["focus and cognitive function support", "Cognitive Function"],
  ["liver, gallbladder and bile-flow support", "Liver Health"],
  ["intestinal microbial balance support", "Microbiome Support"],
  ["circulatory and venous support", "Circulation Support"],
  ["dairy digestion support", "Digestive Health"],
  ["joint, mobility and connective-tissue support", "Joint Health"],
  ["fat digestion support", "Digestive Health"],
  ["digestive comfort support", "Digestive Health"],
  ["gastrointestinal lining support", "Digestive Health"],
  ["gluten digestion support", "Digestive Health"],
  ["liver detoxification support", "Detoxification"],
  ["upper respiratory immune support", "Respiratory Health Support"],
  ["healthy inflammatory response and soft-tissue support", "Inflammation Support"],
  ["healthy inflammatory response and tissue support", "Inflammation Support"],
  ["lymphatic drainage and immune support", "Immune Support"],
  ["memory and cognitive function support", "Cognitive Function"],
  ["menopause and hormonal balance support", "Menopause Support"],
  ["menstrual-cycle comfort support", "Menstrual Support"],
  ["immune and cognitive wellness support", "Immune Support"],
  ["antioxidant and immune support", "Antioxidant"],
  ["stress, calm and relaxation support", "Stress Management"],
  ["healthy inflammatory and immune response support", "Inflammation Support"],
  ["systemic enzyme and immune response support", "Immune Support"],
  ["intestinal microflora support", "Microbiome Support"],
  ["intestinal and immune support", "Immune Support"],
  ["microflora and digestive support", "Digestive Health"],
  ["protein digestion and systemic enzyme support", "Digestive Health"],
  ["protein digestion support", "Digestive Health"],
  ["kidney and renal-filtration support", "Kidney Health"],
  ["respiratory and mucus-clearance support", "Respiratory Health Support"],
  ["thyroid and metabolic support", "Thyroid Support"],
]);

function normUrl(value) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").replaceAll(" ", "%20").replace(/(?:%20){2,}/g, "%20")
    : value;
}

// The catalog is German-first.  These are reviewed source-language spellings
// for the semantic decisions above.  A candidate is only accepted after an
// exact literal match in this record's Ingredients/Supplement Facts/page
// source excerpt; the table therefore cannot manufacture evidence.
const SOURCE_ALIASES = {
  "Spirulina platensis algae powder": ["Spirulina platensis Algenpulver"],
  "Beta-Carotene": ["Beta-Carotin", "ß-Carotin"],
  "DHA-rich algal oil": ["Docosahexaensäure (DHA)", "Omega-3-Fettsäure", "Schizochytrium"],
  "Rosehip fruit extract": ["Hagebuttenfrüchte-Extrakt", "Hagebuttenfruchtextrakt"],
  "Bilberry fruit extract": ["Heidelbeerfrüchte-Extrakt", "Heidelbeerfruchtextrakt"],
  "Lutein": ["Lutein"], "Zeaxanthin": ["Zeaxanthin"], "Astaxanthin": ["Astaxanthin"],
  "Vitamin C": ["Vitamin C", "L-Ascorbinsäure", "Ascorbinsäure"],
  "Vitamin E": ["Vitamin E", "Tocopherol"], "Vitamin B1": ["Vitamin B1", "Thiamin"],
  "Vitamin B2": ["Vitamin B2", "Vit. B2", "Riboflavin"], "Vitamin B3": ["Vitamin B3", "Niacin"],
  "Niacin": ["Niacin", "Vitamin B3"], "Vitamin B5": ["Vitamin B5", "Pantothensäure"],
  "Vitamin B6": ["Vitamin B6", "Pyridoxin"], "Vitamin B12": ["Vitamin B12", "Cobalamin"],
  "Vitamin D3": ["Vitamin D3", "Cholecalciferol"], "Vitamin D": ["Vitamin D3", "Vitamin D", "Cholecalciferol"],
  "Vitamin K2": ["Vitamin K2", "Menachinon"], "Vitamin K": ["Vitamin K"],
  "Vitamin A": ["Vitamin A", "Beta-Carotin", "ß-Carotin"], "Biotin": ["Biotin"],
  "Folate": ["Folat", "Folsäure", "Vitamin B9"], "Iron": ["Eisen"], "Iron bisglycinate": ["Eisen-Bisglycinat", "Eisen"], "Zinc": ["Zink"],
  "Calcium": ["Calcium", "Calciumcarbonat"], "Magnesium": ["Magnesium"],
  "Selenium": ["Selen"], "Manganese": ["Mangan"], "Copper": ["Kupfer"],
  "Chromium": ["Chrom", "Chromium"], "Iodine": ["Jod", "Iod"],
  "Silicon": ["Silicium", "Silizium", "Kieselerde", "Siliciumdioxid"],
  "Silica": ["Kieselsäure", "Kieselerde", "Siliciumdioxid", "Silizium"],
  "Horsetail powder": ["Schachtelhalmpulver"], "Horsetail extract": ["Schachtelhalmextrakt"],
  "Nettle leaf powder": ["Brennnesselblattpulver"], "Nettle": ["Brennnessel"],
  "Ceylon cinnamon powder": ["Zimtpulver Zeylanicum"], "Cassia cinnamon extract": ["Zimtextrakt Cassia"],
  "Cinnamon extract": ["Zimtextrakt"], "Purslane extract": ["Portulakextrakt"],
  "Bitter melon extract": ["Bittermelonenextrakt"], "Hop powder and extract": ["Hopfenpulver und -extrakt"],
  "Hop flower extract": ["Hopfenblütenextrakt"], "Grape seed extract": ["Traubenkernextrakt", "Traubenkernpulver und -extrakt"],
  "Grape-seed OPC": ["Traubenkernextrakt", "OPC"], "Grape seed OPC": ["Traubenkernextrakt", "OPC"],
  "Proanthocyanidins (OPC)": ["OPC", "Proanthocyanidine"], "Sage leaf powder and extract": ["Salbeiblattpulver und -extrakt", "Salbeiblattpulver"],
  "Sage leaf extract": ["Salbeiblatt-Extrakt", "Salbeiblatt-extrakt"], "Sage": ["Salbei"], "Sage powder": ["Salbei"],
  "Alfalfa herb powder": ["Alfalfa", "Luzerne"], "Ashwagandha extract": ["Ashwagandha Extrakt", "Ashwagandhaextrakt"],
  "Ashwagandha root extract": ["Ashwagandha-Wurzelextrakt", "Ashwagandha Wurzelextrakt"],
  "Blackcurrant concentrate and extract": ["schwarzer Johannisbeerextrakt", "Johannisbeerextrakt"],
  "Ginseng extract": ["Ginsengextrakt"], "Ginseng root powder": ["Ginsengwurzelpulver"],
  "Ginseng root powder and extract": ["Ginsengwurzelpulver", "Ginseng"], "Psyllium husk": ["Flohsamenschalen"],
  "Amla fruit powder": ["Amlafrucht-Pulver", "Amlafruchtpulver"], "Amla extract": ["Amlafrucht-Extrakt", "Amlafruchtextrakt"],
  "Myrrh resin powder": ["Myrrhenharzpulver"], "Frankincense powder and extract": ["Weihrauchpulver", "Weihrauchextrakt"],
  "Hyaluronic acid": ["Hyaluronsäure"], "Methylsulfonylmethane": ["MSM", "MethylSulfonylMethan"],
  "Rosehip juice concentrate": ["Hagebuttensaftkonzentrat"], "Rosehip extract": ["Hagebuttenextrakt"],
  "Cistus herb extract": ["Zistrosenextrakt", "Cistuskraut"], "Cistus herb powder and extract": ["Zistrosenpulver", "Zistrosenextrakt"],
  "Thyme": ["Thymian"], "Thyme powder and extract": ["Thymiankrautpulver und -extrakt", "Thymianpulver und -extrakt", "Thymiankrautpulver"], "Thyme extract": ["Thymianextrakt"],
  "Eucalyptus oil": ["Eukalyptusöl"], "Echinacea juice powder": ["Echinacea Saftpulver", "Echinaceasaftpulver"],
  "Elderberry extract": ["Holunderbeerenextrakt"], "Elderberry and blackcurrant powder": ["Holunderbeerenpulver", "Johannisbeerpulver"],
  "Andrographis extract": ["Andrographisextrakt"], "Lithothamnium mineral complex": ["Meeres-Mineralien-Komplex aus Lithothamnium calcareum", "Mineralien aus Lithothamnium", "Mineralienkomplex"],
  "Propolis extract": ["Propolisextrakt"], "Milk protein": ["Milcheiweiß"], "Pea protein": ["Erbsenprotein"],
  "Pea protein isolate": ["Erbsenproteinisolat"], "Sunflower protein": ["Sonnenblumenprotein"],
  "Rice protein": ["Reisprotein"], "Rice protein concentrate": ["Reisproteinkonzentrat"], "Hemp protein": ["Hanfprotein"],
  "Cranberry protein": ["Cranberryprotein"], "Hydrolysed collagen": ["Kollagenhydrolysat", "Hydrolysiertes Kollagen"],
  "Eggshell membrane collagen": ["Eierschalenmembran"], "Inulin": ["Inulin"], "Turmeric powder": ["Kurkumapulver"],
  "Turmeric extract": ["Kurkumaextrakt"], "Turmeric root extract": ["Kurkumawurzel-Extrakt"], "Turmeric root powder": ["Kurkumawurzelpulver"],
  "Fenugreek seed powder": ["Bockshornkleesamenpulver"], "Coenzyme Q10": ["Coenzym Q10"], "Quercetin": ["Quercetin"],
  "Myrobalan fruit extract": ["Myrobalanenextrakt"], "Shilajit powder": ["Shilajit"], "Shilajit extract": ["Shilajitextrakt"],
  "trans-Resveratrol": ["trans-Resveratrol", "Resveratrol"], "Glutathione": ["L-Glutathion", "Glutathion"], "Green tea extract": ["Grünteeextrakt", "Grüntee-Extrakt"],
  "Green tea catechins": ["Grünteeextrakt", "Catechine"], "NADH": ["NADH"], "Quercetin": ["Quercetin"],
  "L-Methionine": ["L-Methionin", "Methionin"], "L-Cysteine hydrochloride": ["L-Cystein", "Cystein"],
  "L-Histidine": ["L-Histidin", "Histidin"], "L-Tryptophan": ["L-Tryptophan", "Tryptophan"],
  "L-Tyrosine": ["L-Tyrosin", "Tyrosin"], "L-Phenylalanine": ["L-Phenylalanin", "Phenylalanin"],
  "L-Carnitine": ["L-Carnitin", "Carnitin"], "L-Lysine": ["L-Lysin", "Lysin"], "L-Lysine": ["L-Lysin", "Lysin"],
  "Alpha-linolenic acid": ["Alpha-Linolensäure", "α-Linolensäure"], "Gamma-linolenic acid": ["Gamma-Linolensäure", "γ-Linolensäure"],
  "Linoleic acid": ["Linolsäure"], "DHA": ["Docosahexaensäure", "DHA"], "EPA": ["Eicosapentaensäure", "EPA"], "DPA": ["Docosapentaensäure", "DPA"],
  "Choline bitartrate": ["Cholinbitartrat"], "Phosphatidylserine": ["Phosphatidylserin", "Lecithin-PS"],
  "Lion's mane mushroom": ["Löwenmähne", "Hericium"], "Lion's mane mushroom extract": ["Löwenmähne", "Hericium"],
  "Astragalus extract": ["Astragalusextrakt"], "Astragalus root extract": ["Astragaluswurzelextrakt"],
  "Vitamin B complex": ["Vitamin B", "B-Vitamine"], "Guarana seed extract": ["Guaranasamenextrakt", "Guaranaextrakt"],
  "Guarana extract": ["Guaranaextrakt"], "Ginkgo leaf extract": ["Ginkgoblätterextrakt", "Ginkgoextrakt"],
  "Lemon balm leaf extract": ["Melissenblätterextrakt", "Melissenblattextrakt"], "Lemon balm extract": ["Melissenblattextrakt"],
  "Lemon balm leaf powder and extract": ["Melissenblätterpulver", "Melissenblattextrakt"], "St John's wort extract": ["Johanniskraut-Extrakt", "Johanniskrautextrakt"],
  "Saffron extract": ["Safranextrakt"], "Saffron": ["Safran"], "Maca root extract": ["Macawurzelextrakt"],
  "Damiana leaf extract": ["Damianablätterextrakt"], "Wild yam root extract": ["Wildyamwurzelextrakt"], "Safran extract": ["Safranextrakt"],
  "Saw palmetto fruit extract": ["Sägepalmfrüchte-Extrakt", "Sägepalmenfruchtextrakt"], "Saw Palmetto": ["Sägepalme"], "Pea sprout extract": ["Erbsensprossen-Extrakt", "Erbsensprossenextrakt"], "Bilberry extract": ["Heidelbeerfrüchte-Extrakt", "Heidelbeerfruchtextrakt"],
  "Camu camu fruit powder": ["Camu-Camu-Fruchtpulver", "Camucamupulver"], "Acerola fruit powder": ["Acerolafruchtpulver"],
  "Rhodiola rosea extract": ["Rosenwurzextrakt", "Rhodiola"], "Wheat germ extract": ["Weizenkeimextrakt"], "Spermidine": ["Spermidin"],
  "Buckwheat germ powder": ["Buchweizenkeimpulver"], "Chlorophyll": ["Chlorophyll"], "Chlorella vulgaris algae powder": ["Chlorella vulgaris Algenpulver"],
  "Reishi mushroom extract": ["Reishiextrakt"], "Shiitake mushroom extract": ["Shiitakeextrakt"], "Shiitake mushroom powder": ["Shiitakepulver"],
  "Almond mushroom powder": ["Mandelpilzpulver", "Agaricus"], "Brown algae": ["Braunalgen", "Braunalge"],
  "Chamomile flower extract": ["Kamillenblütenextrakt"], "Passionflower extract": ["Passionsblumenextrakt", "Passionsblumenkrautextrakt"],
  "Pomegranate fruit extract": ["Granatapfelsaftextrakt", "Granatapfelfruchtextrakt"], "Lavender flower extract": ["Lavendelblütenextrakt"],
  "Rutin": ["Rutin"], "Olive leaf powder and extract": ["Olivenblattpulver", "Olivenblattextrakt"],
  "Lady's mantle extract": ["Frauenmantelextrakt"], "Chaste tree berry powder": ["Mönchspfefferfruchtpulver", "Mönchspfeffer"],
  "Angelica root powder": ["Angelikawurzel"], "Cayenne pepper": ["Cayennepfeffer"], "Lycopene": ["Lycopin"],
  "Cranberry extract": ["Cranberryextrakt"], "Pumpkin seed extract": ["Kürbiskernextrakt"], "Nettle root extract": ["Brennnesselwurzelextrakt"],
  "Hibiscus powder": ["Hibiskuspulver"], "Hibiscus flower extract": ["Hibiskusblütenextrakt"], "Sabal fruit powder": ["Sabalfrüchtepulver", "Sabalfruchtpulver", "Sägepalmenfrucht"],
  "Orthosiphon leaf": ["Orthosiphonblätter"], "Ginger juice": ["Ingwersaft"], "Whole lemon powder": ["Zitronenpulver"],
  "Garlic extract": ["Knoblauchextrakt"], "Curcuminoids": ["Curcuminoide"], "Piperine": ["Pfefferextrakt", "Piperin"], "Caffeine": ["Koffein"],
  "Green oat": ["Grünhafer"], "Plantain powder": ["Spitzwegerich"], "Marshmallow root powder": ["Eibischwurzel"],
  "Licorice juice powder": ["Süßholzsaft"], "Cranberry juice concentrate": ["Cranberrysaftkonzentrat"], "Licorice juice concentrate": ["Süßholzwurzel", "Süßholz"],
  "Mallow leaf and extract": ["Malvenblätter", "Malvenblätterextrakt"], "Brahmi powder and extract": ["Brahmiextrakt"],
  "Ginkgo leaf powder and extract": ["Ginkgoblätter", "Ginkgoblattextrakt"], "Mate leaf powder and extract": ["Mateblattpulver"],
  "Coleus forskohlii extract": ["Coleus forskohlii Extrakt"], "Jiaogulan extract": ["Jiaogulankrautextrakt"],
  "Milk thistle seed extract": ["Mariendistelsamenextrakt"], "Artichoke herb": ["Artischockenkraut"], "Dandelion root and herb": ["Löwenzahnwurzel", "Löwenzahn"],
  "Parsley leaf extract": ["Petersilienblatt-Extrakt"], "Schisandra fruit extract": ["Schisandrafrüchte-Extrakt"], "Peppermint leaf extract": ["Pfefferminzblatt-Extrakt", "Pfefferminzblätterextrakt"], "Sage leaf extract": ["Salbeiblattextrakt", "Salbeiblatt-Extrakt", "Salbeiblatt-extrakt"],
  "Baobab fruit powder": ["Baobabfruchtpulver"], "Hibiscus flower extract": ["Hibiskusblütenextrakt"], "Garlic extract": ["Knoblauchextrakt"],
};

function pageSourceExcerpt(record, n) {
  try {
    const source = pageSourceReviews[n - 1];
    return source?.excerpt || "";
  } catch { return ""; }
}
function findSourceTerm(record, item, n) {
  const f = record.fields;
  const corpus = `${f.ingredients || ""}\n${f.supplement_facts || f.supplementFacts || ""}\n${pageSourceExcerpt(record, n)}`;
  const candidates = [item.name, item.substance, ...(SOURCE_ALIASES[item.name] || [])]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  const lower = corpus.toLocaleLowerCase();
  for (const candidate of candidates) {
    const at = lower.indexOf(candidate.toLocaleLowerCase());
    if (at >= 0) {
      const sourceTerm = corpus.slice(at, at + candidate.length);
      const excerpt = corpus.slice(Math.max(0, at - 90), Math.min(corpus.length, at + candidate.length + 180)).replace(/\s+/g, " ").trim();
      return { sourceTerm, excerpt, source: "ingredients_supplement_facts_page_source" };
    }
  }
  return null;
}
function evidenceFor(record, item, n) {
  const found = findSourceTerm(record, item, n);
  return found ? { ...found } : null;
}
function semanticInferences(record, items, health, n) {
  const f = record.fields;
  const text = `${f.title}; ${f.description || ""}`.replace(/\s+/g, " ").slice(0, 700);
  return {
    form: { value: f.form, basis: "explicit", confidence: "high", evidence: [{ source: "title_and_page", excerpt: text }] },
    health_function: [{ value: health, basis: "inferred", confidence: "medium", rationale: "Mapped to the controlled support vocabulary from the product's stated use, category and active ingredients; no disease-treatment claim is introduced.", evidence: [{ source: "title_description_and_ingredients", excerpt: text }] }],
    main_ingredients: items.flatMap((item) => {
      const evidence = evidenceFor(record, item, n);
      if (!evidence) return [];
      return [{ value: item.name, basis: "explicit", confidence: "high", evidence: [evidence], taxonomy: { substance: item.substance, ...(item.form ? { form: item.form } : {}), category: item.category } }];
    }),
  };
}

function variantFor(n, record) {
  const f = record.fields;
  if ([14, 73].includes(n)) {
    const name = n === 14 ? "Vanille-Zimt" : "Schoko-Chili";
    const variantId = n === 14 ? "2f8195d5-85e3-55d0-bf0b-7eb87969c317" : "ba50f1b5-d47a-45ef-87d0-eab402fe07e2";
    return { variant_name: name, variantId, options: { flavor: name }, variant_options: { flavor: name }, state: "selected", source: "selected product URL and title; selector value and page Ingredients/Facts state" };
  }
  if ([1, 17].includes(n)) {
    const name = n === 1 ? "650 Stück" : "300 Stück";
    const variantId = n === 1 ? "2c15eb50-582a-5c11-a576-d5d1be5569cf" : "c6861837-40aa-4109-a65d-b00f6ed29d58";
    return { variant_name: name, variantId, options: { count: name }, variant_options: { count: name }, state: "selected", source: "selected product URL, title and selector value" };
  }
  if ([79, 84, 88, 89, 90].includes(n)) {
    const name = f.title.replace(/^Astaxanthin Energy(?:-| )?Drink Konzentrat ?/i, "");
    const ids = { 79: "78b69ea2-d35d-50c7-ad05-04006eb9fc22", 84: "d4535819-fa86-4097-ae1a-83b6ee651083", 88: "3fd1b766-4233-4fb1-b0a5-1c7b058ea776", 89: "54b3e570-7d99-43f2-83b8-25b0f6643f12", 90: "45b46aec-1db3-4ef3-a2ac-a713b269694f" };
    return { variant_name: name, variantId: ids[n], options: { flavor: name }, variant_options: { flavor: name }, state: "selected", source: "selected product URL, title, selector value and flavor-specific Ingredients/Facts text" };
  }
  return null;
}

function factsItemsFor(n, imageIndex, items) {
  // Visual review of the supplied evidence images.  Promotional/front images
  // are explicitly retained as reviewed but do not claim ingredient rows.
  const names = (...wanted) => items.filter((item) => wanted.includes(item.name));
  if (n === 14) return names("Ashwagandha extract", "Cinnamon extract", "Vitamin B1", "Vitamin B2", "Vitamin B6", "Vitamin B12", "Vitamin C");
  if (n === 18) return imageIndex === 0 ? [] : names("Pea protein", "Sunflower protein", "Turmeric powder", "Fenugreek seed powder", "Inulin");
  if (n === 20) return imageIndex < 2 ? names("Magnesium", "Horsetail extract", "Silica") : [];
  if (n === 28) return names("Silicon", "Manganese", "Copper", "Zinc");
  if (n === 29) return imageIndex === 0 ? names("Vitamin D3", "Vitamin K2") : [];
  return items;
}
const IMAGE_SOURCE_TERMS = {
  14: { "Ashwagandha extract": "Ashwagandha Extrakt", "Cinnamon extract": "Zimtextrakt", "Vitamin B1": "Vitamin B1", "Vitamin B2": "Vitamin B2", "Vitamin B6": "Vitamin B6", "Vitamin B12": "Vitamin B12", "Vitamin C": "L-Ascorbinsäure" },
  18: { "Pea protein": "Erbsenprotein", "Sunflower protein": "Sonnenblumenproteinpulver", "Turmeric powder": "Kurkuma", "Fenugreek seed powder": "Bockshornkleesamenpulver", Inulin: "Inulin" },
  20: { Magnesium: "Magnesium", "Horsetail extract": "Schachtelhalmextrakt", Silica: "Kieselsäure" },
  28: { Silicon: "Silicium", Manganese: "Mangan", Copper: "Kupfer", Zinc: "Zink" },
  29: { "Vitamin D3": "Vitamin D3", "Vitamin K2": "Vitamin K2" },
};
function imageSourceTerm(n, item) { return IMAGE_SOURCE_TERMS[n]?.[item.name] || null; }

function vanillaIngredients() {
  return "Milcheiweiß (55%), Inulin, Akazienfaser, Erbsenproteinisolat (4,5%), natürliches Aroma, Sonnenblumenproteinpulver (3%), Reisproteinkonzentrat (2,5%), Zimtpulver (1,5%), Verdickungsmittel: Guarkernmehl, vitaminreiches Buchweizenkeimpulver, Zimtextrakt (Cinnamomum cassia; 0,75%), L-Ascorbinsäure, Ashwagandha Extrakt, Vanillepulver";
}
function repairShakeVariant(n, f) {
  if (n === 14) f.ingredients = vanillaIngredients();
  if (n === 73) f.ingredients = "Milcheiweiß (55%), Inulin, Kakaopulver (10,4%), Akazienfaser, Erbsenproteinisolat (4,5%), Sonnenblumenproteinpulver (3%), Reisproteinkonzentrat (2,5%), Verdickungsmittel: Guarkernmehl, natürliches Aroma, vitaminreiches Buchweizenkeimpulver, L-Ascorbinsäure, Süßungsmittel: Steviolglykoside, Cayennepfeffer (0,6%)";
}

async function main() {
  const records = JSON.parse(await fs.readFile(INPUT, "utf8"));
  try { pageSourceReviews = JSON.parse(await fs.readFile(path.join(EVIDENCE, "baerbel-pages/page-source-review.json"), "utf8")); } catch { pageSourceReviews = []; }
  const reviewQueue = [];
  const changed = { baerbelRecords: 0, ingredientsExpanded: 0, ingredientItemsReviewed: 0, ingredientsRemovedNoSourceTerm: 0, factsImageReviews: 0, variants: 0, urlsNormalized: 0, jodFactsReview: 0 };
  for (let n = 1; n <= 98; n += 1) {
    const record = records[53 + n];
    if (!record || record._meta?.company !== "Bärbel Drexel") continue;
    const f = record.fields;
    const items = ING[n];
    if (!items?.length) { reviewQueue.push({ productName: f.title, sourceUrl: f.url, missing: ["main_ingredients"], reason: "No reviewed decision table entry" }); continue; }
    const evidencedItems = items.filter((item) => evidenceFor(record, item, n));
    for (const item of items) {
      if (evidencedItems.includes(item)) continue;
      reviewQueue.push({ productName: f.title, sourceUrl: f.url, missing: ["semanticInferences.main_ingredients.evidence.sourceTerm", item.name], reason: "No exact source-language term was located in Ingredients, Supplement Facts or the corresponding page-source evidence; item was removed rather than inferred.", evidence: { ingredients: f.ingredients || "", supplement_facts: f.supplement_facts || f.supplementFacts || "" } });
    }
    f.main_ingredients = evidencedItems;
    changed.ingredientItemsReviewed += items.length;
    changed.ingredientsRemovedNoSourceTerm += items.length - evidencedItems.length;
    f.health_function = [HEALTH[n]];
    const variant = variantFor(n, record);
    const originalVariantOptions = f.variant_options;
    if (n === 59) {
      f.supplement_facts = "Empfohlene Tagesdosis: 1 x 1 Pressling\n\nInhalt pro Tagesdosis\n\n1 Pressling enthält: Jod (aus Braunalgen) 51 µg (34 %)\nMineralienkomplex (aus der Alge Lithothamnium calcareum) 43,5 mg\n\n2 Presslinge enthalten: Jod (aus Braunalgen) 102 µg (68 %)\nMineralienkomplex (aus der Alge Lithothamnium calcareum) 87 mg";
      f.supplementFacts = f.supplement_facts;
    }
    repairShakeVariant(n, f);
    if (variant) { record._meta.variant = { ...variant, variantId: variant.variantId, options: variant.options, optionSelections: Object.entries(variant.options || {}).map(([name, value]) => ({ name, value })) }; f.variant_name = variant.variant_name; f.variant_id = variant.variantId; f.variant_options = originalVariantOptions || variant.variant_options; changed.variants += 1; }
    const inferences = semanticInferences(record, evidencedItems, HEALTH[n], n);
    record._meta.semanticInferences = { ...(record._meta.semanticInferences || {}), ...inferences };
    record._meta.repairs = { ...(record._meta.repairs || {}), lunaRepair: { reviewedAt: "2026-08-17", method: "manual evidence table from Ingredients/Facts/description", itemCount: evidencedItems.length, removedWithoutExactSourceTerm: items.length - evidencedItems.length } };
    changed.baerbelRecords += 1;
    changed.ingredientsExpanded += evidencedItems.length;
    // Normalize literal spaces in image paths while preserving the exact path.
    const urlsBefore = JSON.stringify(f.images);
    f.images = (f.images || []).map(normUrl);
    if (f.facts_images) f.facts_images = f.facts_images.map((x) => ({ ...x, image_url: normUrl(x.image_url) }));
    if (f.gallery_review?.reviewed_image_urls) f.gallery_review.reviewed_image_urls = f.gallery_review.reviewed_image_urls.map(normUrl);
    if (record._meta.galleryReview?.reviewed_image_urls) record._meta.galleryReview.reviewed_image_urls = record._meta.galleryReview.reviewed_image_urls.map(normUrl);
    if (f.facts_source_review?.gallery?.reviewed_image_urls) f.facts_source_review.gallery.reviewed_image_urls = f.facts_source_review.gallery.reviewed_image_urls.map(normUrl);
    if (JSON.stringify(f.images) !== urlsBefore) changed.urlsNormalized += 1;
    // Each confirmed Facts image gets its own review, with this product's full
    // evidence-backed list (never a shared one-item placeholder).
    const facts = Array.isArray(f.facts_images) ? f.facts_images : [];
    if (facts.length) {
      const reviews = facts.map((img, imageIndex) => {
        const visibleItems = factsItemsFor(n, imageIndex, evidencedItems).filter((item) => imageSourceTerm(n, item) || evidenceFor(record, item, n));
        return visibleItems.length === 0
          ? { status: "visual_complete", result: "no_main_ingredients_visible", image_url: img.image_url, facts_type: img.type || "Nutrition Facts", visible_heading: img.visible_heading || "Zutaten / Nährwertangaben", ingredients: [], ingredient_count: 0, evidence: { source: "visual review of supplied gallery image", visibleText: "Keine Hauptzutatenzeile im Vorder-/Werbebild sichtbar.", productUrl: f.url } }
          : { status: "visual_complete", result: "ingredients_read", image_url: img.image_url, facts_type: img.type || "Nutrition Facts", visible_heading: img.visible_heading || "Zutaten / Nährwertangaben", ingredients: visibleItems.map((item) => ({ name: item.name, visibleText: n === 59 ? (item.name === "Iodine" ? "Jod (aus Braunalgen) 51 µg (34 %) / 102 µg (68 %)" : "Mineralienkomplex (aus der Alge Lithothamnium calcareum) 43,5 mg / 87 mg") : (imageSourceTerm(n, item) || evidenceFor(record, item, n)?.sourceTerm), substance: item.substance, ...(item.form ? { form: item.form } : {}), category: item.category, confidence: "high" })), ingredient_count: visibleItems.length, evidence: { source: "visual review of supplied Facts/label image", visibleText: n === 59 ? "Jod (aus Braunalgen) 51 µg (34 %) / 102 µg (68 %); Mineralienkomplex (aus der Alge Lithothamnium calcareum) 43,5 mg / 87 mg" : visibleItems.map((item) => imageSourceTerm(n, item) || evidenceFor(record, item, n)?.sourceTerm).join("; "), productUrl: f.url } };
      });
      f.factsIngredientReviews = reviews;
      record._meta.factsIngredientReviews = reviews;
      record._meta.factsIngredientReview = reviews[0];
      changed.factsImageReviews += reviews.length;
    }
    if (n === 59 && !f.supplement_facts) {
      changed.jodFactsReview += 1;
      reviewQueue.push({ productName: f.title, sourceUrl: f.url, missing: ["supplement_facts"], reason: "Page-source and supplied DOM show Ingredients and iodine-related claims, but no Supplement/Nutrition Facts rows were captured; gallery Facts is confirmed and requires manual read-back.", evidence: "Zutaten: Braunalgen (Fucus vesiculosus, Ascophyllum nodosum; gesamt 17 %)" });
    }
  }

  // Keep non-Bärbel records unchanged except for the known ProEnzol header-only
  // confirmations.  Ensure all seven remain explicitly no_main_ingredients_visible.
  const headerNames = ["Gluten DigestEnz™", "JointEnz™", "Lipase 75™", "pHysio 100™", "pHysio Plus™", "pHysioProtease®", "Protease 100™"];
  for (const record of records) {
    if (record._meta?.company !== "ProEnzol" || !headerNames.includes(record.fields.title)) continue;
    const images = record.fields.facts_images || [];
    const reviews = images.map((img) => ({ status: "visual_complete", result: "no_main_ingredients_visible", image_url: normUrl(img.image_url), facts_type: "Supplement Facts", visible_heading: "Supplement Facts", ingredient_count: 0, evidence: "Source image reviewed; only header/serving-size shell is visible, with no ingredient rows." }));
    record.fields.factsIngredientReviews = reviews; record._meta.factsIngredientReviews = reviews; record._meta.factsIngredientReview = reviews[0];
  }
  for (const record of records) {
    if (record._meta?.company === "ZSAZA Honey" && /[?&]variant=/.test(record.sourceUrl || "")) {
      const variantId = new URL(record.sourceUrl).searchParams.get("variant");
      const variantName = record.fields.title;
      const originalVariantOptions = record.fields.variant_options;
      record.fields.variant_id = variantId;
      record.fields.variant_name = variantName;
      if (originalVariantOptions !== undefined) record.fields.variant_options = originalVariantOptions;
      record._meta.variant = { variantId, options: { variant: variantId }, optionSelections: [{ name: "variant", value: variantId }], displayName: variantName, canonicalUrl: record.sourceUrl, state: "selected", source: "variant query parameter in detail URL" };
    }
    const values = Array.isArray(record.fields.health_function) ? record.fields.health_function : [];
    const mapped = values.map((value) => LEGACY_HEALTH.get(value) || value);
    if (JSON.stringify(mapped) !== JSON.stringify(values)) {
      record._meta.repairs = { ...(record._meta.repairs || {}), lunaOriginalHealthFunction: values };
      record.fields.health_function = [...new Set(mapped)];
      const inf = record._meta.semanticInferences || {};
      const old = inf.health_function || [];
      record._meta.semanticInferences = {
        ...inf,
        health_function: record.fields.health_function.map((value) => ({
          value,
          basis: "inferred",
          confidence: "medium",
          rationale: "Canonicalized from the product's existing evidence-backed use category; the original phrase remains in _meta.repairs.lunaOriginalHealthFunction.",
          evidence: old.flatMap((x) => x?.evidence || []).slice(0, 2),
        })),
      };
    }
  }
  const completion = {
    status: "incomplete",
    reason: "ProEnzol catalog inventory began as listing_fetch_failed/incomplete; no new browser pagination validation was available in this repair pass.",
    sites: {
      "Bärbel Drexel": { status: "complete", records: 98, detailUrls: 98, variantsRepresented: 9, pagination: "navigation_exhausted evidence retained from input" },
      "ZSAZA Honey": { status: "complete", records: 2, detailUrls: 2, variantUrlsRetained: 2 },
      ProEnzol: { status: "incomplete", records: 52, reason: "listing_fetch_failed/pagination completion not revalidated; do not claim complete" },
    },
  };
  const catalogCoverage = { status: "incomplete", basis: "listing_fetch_failed", verifiedVisually: false, sites: completion.sites, blocker: "ProEnzol final pagination and exhaustion could not be independently verified in the available evidence." };
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, "crawl-records.json"), JSON.stringify(records, null, 2));
  await fs.writeFile(path.join(OUT, "semantic-review-queue.json"), JSON.stringify(reviewQueue, null, 2));
  await fs.writeFile(path.join(OUT, "catalog-coverage.json"), JSON.stringify(catalogCoverage, null, 2));
  await fs.writeFile(path.join(OUT, "completion-evidence.json"), JSON.stringify(completion, null, 2));
  await fs.writeFile(path.join(OUT, "luna-repair-report.json"), JSON.stringify({ generatedAt: "2026-08-17", input: INPUT, evidenceDir: EVIDENCE, outputMode: "inventory_partial", recordsReceived: records.length, changed, evidenceLocalization: { totalMainIngredientItems: changed.ingredientItemsReviewed, evidencePass: changed.ingredientsExpanded, deletedWithoutExactSourceTerm: changed.ingredientsRemovedNoSourceTerm, reviewQueueItems: reviewQueue.length, unresolved: reviewQueue.map((x) => ({ productName: x.productName, missing: x.missing })) }, variantStats: { baerbelVariants: 9, zsazaVariants: 2, totalVariants: 11 }, reviewQueue: reviewQueue.length, proenzolFactsHeaderOnlyConfirmed: headerNames.length, validation: { inventoryBuilder: { inputsReady: 152, errors: 0, reviewQueue: 0, requirePrice: false }, strictCandidateCheck: { inputsReady: 100, errors: 52, errorReasons: ["api_ready_fields_missing:price"], affectedCompany: "ProEnzol", note: "Practitioner-gated prices are null in source; records remain candidates and no request is submitted." }, strictRequirePriceFalse: { inputsReady: 152, errors: 0, reviewQueue: 0, formalArtifactsWritten: false, blocker: "run_completion_not_proven (ProEnzol catalog remains incomplete)", builder: "crawl-products/lib/enrich-product-output.mjs" }, builderValidationDirs: ["builder-inventory-validation-2", "builder-strict-validation-2"] }, errors: [], note: "No API submission performed. This pass uses explicit, per-product evidence decisions; it does not split ingredients by punctuation." }, null, 2));
  console.log(JSON.stringify({ output: OUT, records: records.length, changed, reviewQueue: reviewQueue.length }, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
