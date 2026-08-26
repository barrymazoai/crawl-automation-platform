#!/usr/bin/env python3
import concurrent.futures
import hashlib
import io
import json
import mimetypes
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
RUN_DIR = ROOT / "real-crawl-results" / "irwin-naturals-20260820"
ASSET_DIR = RUN_DIR / "image-review" / "assets"
GALLERY_SHEET_DIR = RUN_DIR / "image-review" / "gallery-sheets"
FACTS_SHEET_DIR = RUN_DIR / "image-review" / "facts-sheets"


def normalize_url(value):
    if not value:
        return None
    value = value.strip()
    if value.startswith("//"):
        value = "https:" + value
    return value if value.startswith(("http://", "https://")) else None


def identity(url):
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query = [(k, v) for k, v in query if k.lower() not in {"width", "height", "w", "h"}]
    return urllib.parse.urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path, urllib.parse.urlencode(query), ""))


def extension_for(content_type, url):
    ext = mimetypes.guess_extension((content_type or "").split(";", 1)[0].strip())
    if ext == ".jpe":
        ext = ".jpg"
    if ext in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"}:
        return ext
    suffix = Path(urllib.parse.urlsplit(url).path).suffix.lower()
    return suffix if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif"} else ".img"


def download(entry):
    request = urllib.request.Request(entry["url"], headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read()
            content_type = response.headers.get("Content-Type", "")
        image = Image.open(io.BytesIO(data))
        image.load()
        ext = extension_for(content_type, entry["url"])
        path = ASSET_DIR / f'{entry["id"]:04d}{ext}'
        path.write_bytes(data)
        return {**entry, "path": str(path), "contentType": content_type, "width": image.width, "height": image.height, "ok": True}
    except Exception as exc:
        return {**entry, "ok": False, "error": str(exc), "path": None, "width": 0, "height": 0, "contentType": ""}


def label_text(entry, facts=False):
    owner = (entry.get("owners") or [{}])[0]
    title = owner.get("title") or owner.get("productUrl") or ""
    marker = "FACTS" if facts else "GALLERY"
    return f'{entry["id"]:04d} {marker} | {title[:50]} | image {owner.get("index", "?")}'


def build_sheets(entries, out_dir, cols, rows, cell_w, cell_h, prefix, facts=False):
    out_dir.mkdir(parents=True, exist_ok=True)
    font = ImageFont.load_default()
    per_sheet = cols * rows
    sheets = []
    for start in range(0, len(entries), per_sheet):
        batch = entries[start:start + per_sheet]
        canvas = Image.new("RGB", (cols * cell_w, rows * cell_h), "white")
        draw = ImageDraw.Draw(canvas)
        for offset, entry in enumerate(batch):
            x = (offset % cols) * cell_w
            y = (offset // cols) * cell_h
            box_h = cell_h - 40
            try:
                image = Image.open(entry["path"]).convert("RGB")
                image.thumbnail((cell_w - 16, box_h - 12), Image.Resampling.LANCZOS)
                px = x + (cell_w - image.width) // 2
                py = y + 4 + (box_h - image.height) // 2
                canvas.paste(image, (px, py))
            except Exception:
                draw.rectangle((x + 8, y + 8, x + cell_w - 8, y + box_h - 8), outline="red", width=3)
            draw.rectangle((x, y, x + cell_w - 1, y + cell_h - 1), outline="#999999", width=1)
            draw.text((x + 7, y + cell_h - 34), label_text(entry, facts=facts), fill="black", font=font)
            draw.text((x + 7, y + cell_h - 19), f'{entry.get("width", 0)}x{entry.get("height", 0)}', fill="#555555", font=font)
        number = start // per_sheet + 1
        path = out_dir / f"{prefix}-{number:03d}.jpg"
        canvas.save(path, quality=90)
        sheets.append(str(path))
    return sheets


def main():
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    records = json.loads((RUN_DIR / "crawl-records-raw.json").read_text())
    variants = json.loads((RUN_DIR / "variant-evidence.json").read_text())
    topical = re.compile(r"CBD (?:Balm|Cream|Gel) 1000mg", re.I)
    records = [record for record in records if not topical.search(record.get("fields", {}).get("title", ""))]

    by_identity = {}
    for record in records:
        fields = record.get("fields", {})
        for index, raw_url in enumerate(fields.get("images") or [], start=1):
            url = normalize_url(raw_url)
            if not url:
                continue
            key = identity(url)
            entry = by_identity.setdefault(key, {"url": url, "owners": [], "kinds": set()})
            entry["owners"].append({"productUrl": record.get("sourceUrl"), "title": fields.get("title"), "index": index})
            entry["kinds"].add("gallery")

    facts_keys = set()
    for product_url, evidence in variants.items():
        if product_url not in {record.get("sourceUrl") for record in records}:
            continue
        for index, image in enumerate((evidence or {}).get("factsImages") or [], start=1):
            url = normalize_url(image.get("src"))
            if not url:
                continue
            key = identity(url)
            facts_keys.add(key)
            entry = by_identity.setdefault(key, {"url": url, "owners": [], "kinds": set()})
            title = next((r.get("fields", {}).get("title") for r in records if r.get("sourceUrl") == product_url), product_url)
            entry["owners"].append({"productUrl": product_url, "title": title, "index": index})
            entry["kinds"].add("facts_panel")

    entries = []
    for item_id, (key, entry) in enumerate(sorted(by_identity.items()), start=1):
        entries.append({**entry, "id": item_id, "identity": key, "kinds": sorted(entry["kinds"])})

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        downloaded = list(executor.map(download, entries))

    successful = [entry for entry in downloaded if entry["ok"]]
    facts = [entry for entry in successful if "facts_panel" in entry["kinds"]]
    gallery = [entry for entry in successful if "gallery" in entry["kinds"]]
    gallery_sheets = build_sheets(gallery, GALLERY_SHEET_DIR, 4, 4, 360, 390, "gallery", facts=False)
    facts_sheets = build_sheets(facts, FACTS_SHEET_DIR, 2, 2, 760, 800, "facts", facts=True)

    report = {
        "records": len(records),
        "assetsReceived": len(entries),
        "downloaded": len(successful),
        "failed": len(entries) - len(successful),
        "galleryAssets": len(gallery),
        "factsPanelAssets": len(facts),
        "gallerySheets": gallery_sheets,
        "factsSheets": facts_sheets,
        "failures": [entry for entry in downloaded if not entry["ok"]],
    }
    (RUN_DIR / "image-review" / "asset-manifest.json").write_text(json.dumps(downloaded, indent=2))
    (RUN_DIR / "image-review" / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({key: report[key] for key in ["records", "assetsReceived", "downloaded", "failed", "galleryAssets", "factsPanelAssets"]}, indent=2))


if __name__ == "__main__":
    main()
