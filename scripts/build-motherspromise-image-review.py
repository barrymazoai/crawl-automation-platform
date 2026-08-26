#!/usr/bin/env python3
import concurrent.futures
import io
import json
import mimetypes
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
RUN_DIR = ROOT / "real-crawl-results" / "motherspromise-20260825"
ASSET_DIR = RUN_DIR / "image-review" / "assets"
GALLERY_SHEET_DIR = RUN_DIR / "image-review" / "gallery-sheets"
FACTS_SHEET_DIR = RUN_DIR / "image-review" / "facts-sheets"


def identity(url):
    parsed = urllib.parse.urlsplit(url)
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
             if k.lower() not in {"width", "height", "w", "h"}]
    return urllib.parse.urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path,
                                   urllib.parse.urlencode(query), ""))


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
        path = ASSET_DIR / f'{entry["id"]:03d}{extension_for(content_type, entry["url"])}'
        path.write_bytes(data)
        return {**entry, "path": str(path), "contentType": content_type,
                "width": image.width, "height": image.height, "ok": True}
    except Exception as exc:
        return {**entry, "path": None, "contentType": "", "width": 0, "height": 0,
                "ok": False, "error": str(exc)}


def label_text(entry, facts=False):
    owner = (entry.get("owners") or [{}])[0]
    marker = "FACTS" if facts else "GALLERY"
    return f'{entry["id"]:03d} {marker} | {owner.get("title", "")[:42]} | image {owner.get("index", "?")}'


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
            box_h = cell_h - 42
            try:
                image = Image.open(entry["path"]).convert("RGB")
                image.thumbnail((cell_w - 16, box_h - 12), Image.Resampling.LANCZOS)
                canvas.paste(image, (x + (cell_w - image.width) // 2,
                                     y + 4 + (box_h - image.height) // 2))
            except Exception:
                draw.rectangle((x + 8, y + 8, x + cell_w - 8, y + box_h - 8), outline="red", width=3)
            draw.rectangle((x, y, x + cell_w - 1, y + cell_h - 1), outline="#999999", width=1)
            draw.text((x + 7, y + cell_h - 36), label_text(entry, facts=facts), fill="black", font=font)
            draw.text((x + 7, y + cell_h - 20), f'{entry.get("width", 0)}x{entry.get("height", 0)}',
                      fill="#555555", font=font)
        path = out_dir / f"{prefix}-{start // per_sheet + 1:03d}.jpg"
        canvas.save(path, quality=92)
        sheets.append(str(path))
    return sheets


def main():
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    records = json.loads((RUN_DIR / "raw-browser-extract.json").read_text())
    nutrition = [record for record in records if record.get("title") != "Nipple Butter"]
    by_identity = {}

    def add(url, owner, kind):
        if not url:
            return
        key = identity(url)
        entry = by_identity.setdefault(key, {"url": url, "identity": key, "owners": [], "kinds": set()})
        entry["owners"].append(owner)
        entry["kinds"].add(kind)

    for record in nutrition:
        for index, image in enumerate(record.get("gallery") or [], start=1):
            add(image.get("url"), {"productUrl": record.get("productUrl"),
                                   "title": record.get("title"), "index": index}, "gallery")
        for section in record.get("sections") or []:
            if "supplement facts" not in (section.get("name") or "").lower():
                continue
            for index, image in enumerate(section.get("images") or [], start=1):
                add(image.get("url"), {"productUrl": record.get("productUrl"),
                                       "title": record.get("title"), "index": index}, "facts_panel")

    entries = []
    for item_id, (_, entry) in enumerate(sorted(by_identity.items()), start=1):
        entries.append({**entry, "id": item_id, "kinds": sorted(entry["kinds"])})

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        downloaded = list(executor.map(download, entries))
    successful = [entry for entry in downloaded if entry["ok"]]
    gallery = [entry for entry in successful if "gallery" in entry["kinds"]]
    facts = [entry for entry in successful if "facts_panel" in entry["kinds"]]
    gallery_sheets = build_sheets(gallery, GALLERY_SHEET_DIR, 4, 4, 380, 410, "gallery")
    facts_sheets = build_sheets(facts, FACTS_SHEET_DIR, 2, 2, 780, 820, "facts", facts=True)
    report = {
        "nutritionRecords": len(nutrition),
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
    print(json.dumps({key: report[key] for key in ["nutritionRecords", "assetsReceived", "downloaded",
                                                    "failed", "galleryAssets", "factsPanelAssets"]}, indent=2))


if __name__ == "__main__":
    main()
