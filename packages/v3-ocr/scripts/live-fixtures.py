"""Generate five synthetic OCR images; no customer/product files are read."""
import hashlib
import json
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont

root = Path(sys.argv[1])
root.mkdir(mode=0o700, parents=True, exist_ok=True)
font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 38)
samples = []
for label, amount in [("ALPHA", 101), ("BRAVO", 202), ("CHARLIE", 303), ("DELTA", 404), ("ECHO", 505)]:
    rows = ["SYNTHETIC OCR TEST", f"SAMPLE {label}", f"Vitamin C {amount} mg", "Ingredients: ascorbic acid, cellulose.", "NOT A REAL PRODUCT"]
    image = Image.new("RGB", (1100, 440), "white")
    draw = ImageDraw.Draw(image)
    for n, text in enumerate(rows):
        draw.text((40, 32 + n * 76), text, font=font, fill="black")
    path = root / f"{label}.png"
    with path.open("xb") as out:
        image.save(out, format="PNG")
    image.close()
    blob = path.read_bytes()
    samples.append({"label": label, "amount": amount, "filename": path.name, "sha256": hashlib.sha256(blob).hexdigest(), "byteSize": len(blob), "expectedRows": rows})
with (root / "samples.json").open("x") as out:
    json.dump(samples, out, indent=2)
print(json.dumps({"root": str(root), "syntheticImages": len(samples)}))
