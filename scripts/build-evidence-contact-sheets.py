#!/usr/bin/env python3

from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    source = Path(sys.argv[1])
    output = Path(sys.argv[2])
    patterns = (sys.argv[3] if len(sys.argv) > 3 else "*.jpg").split(",")
    files = sorted(
        {file for pattern in patterns for file in source.glob(pattern.strip())}
    )
    output.mkdir(parents=True, exist_ok=True)

    columns = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    rows = int(sys.argv[5]) if len(sys.argv) > 5 else 2
    cell_width = int(sys.argv[6]) if len(sys.argv) > 6 else 640
    cell_height = int(sys.argv[7]) if len(sys.argv) > 7 else 760
    label_height = 44
    page_size = columns * rows
    font = ImageFont.load_default(size=20)

    for page_index in range(0, len(files), page_size):
        page_files = files[page_index : page_index + page_size]
        sheet = Image.new(
            "RGB",
            (columns * cell_width, rows * cell_height),
            "#161616",
        )
        draw = ImageDraw.Draw(sheet)

        for item_index, file in enumerate(page_files):
            column = item_index % columns
            row = item_index // columns
            x = column * cell_width
            y = row * cell_height
            with Image.open(file) as image:
                rendered = image.convert("RGB")
                rendered.thumbnail(
                    (cell_width - 20, cell_height - label_height - 20),
                    Image.Resampling.LANCZOS,
                )
                image_x = x + (cell_width - rendered.width) // 2
                image_y = y + label_height + (
                    cell_height - label_height - rendered.height
                ) // 2
                sheet.paste(rendered, (image_x, image_y))

            draw.text(
                (x + 12, y + 10),
                file.name,
                fill="white",
                font=font,
            )
            draw.rectangle(
                (x, y, x + cell_width - 1, y + cell_height - 1),
                outline="#555555",
                width=2,
            )

        page_number = page_index // page_size + 1
        sheet.save(output / f"contact-{page_number:02d}.jpg", quality=92)

    print(
        {
            "source_files": len(files),
            "contact_sheets": (len(files) + page_size - 1) // page_size,
            "output": str(output),
        }
    )


if __name__ == "__main__":
    main()
