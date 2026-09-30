"""Generate synthetic, non-customer fixtures in the test-owned destination."""
from pathlib import Path
import sys
from pypdf import PdfWriter, PdfReader

root = Path(sys.argv[1])
writer = PdfWriter()
writer.add_blank_page(width=200, height=300)
with (root / "blank.pdf").open("wb") as out:
    writer.write(out)
for name, password in (("encrypted", "fixture-password"), ("encrypted-empty", "")):
    protected = PdfWriter()
    protected.add_blank_page(width=200, height=300)
    protected.encrypt(user_password=password, owner_password="fixture-owner", algorithm="RC4-128")
    with (root / f"{name}.pdf").open("wb") as out:
        protected.write(out)
many = PdfWriter()
for _ in range(501):
    many.add_blank_page(width=200, height=300)
with (root / "many.pdf").open("wb") as out:
    many.write(out)
huge = PdfWriter()
huge.add_blank_page(width=20000, height=200)
with (root / "huge.pdf").open("wb") as out:
    huge.write(out)
pixels = PdfWriter()
pixels.add_blank_page(width=5000, height=5000)
with (root / "pixels.pdf").open("wb") as out:
    pixels.write(out)
rotated = PdfWriter()
page = PdfReader(root / "nutrition.pdf").pages[0]
page.rotate(90)
rotated.add_page(page)
with (root / "rotated.pdf").open("wb") as out:
    rotated.write(out)
