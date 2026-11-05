"""Generate test page images for the manga reader.

Creates simple but *distinctive* pages so we can verify ordering:
each page has a big page number and a colour band.

Usage:
    python -m tests.make_test_pages --out /tmp/test-pages --count 12
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

COLOURS = [
    (220, 70, 90),
    (70, 140, 220),
    (90, 190, 120),
    (230, 180, 70),
    (160, 110, 220),
    (70, 200, 200),
]


def font(size: int):
    for path in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ):
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="/tmp/test-pages")
    ap.add_argument("--count", type=int, default=12)
    ap.add_argument("--width", type=int, default=800)
    ap.add_argument("--height", type=int, default=1200)
    ap.add_argument("--prefix", default="page")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    for i in range(1, args.count + 1):
        img = Image.new("RGB", (args.width, args.height), (24, 24, 30))
        d = ImageDraw.Draw(img)
        colour = COLOURS[(i - 1) % len(COLOURS)]

        # Top band
        d.rectangle((0, 0, args.width, 150), fill=colour)

        # Big page number
        f = font(110)
        txt = str(i)
        bbox = d.textbbox((0, 0), txt, font=f)
        d.text(
            ((args.width - (bbox[2] - bbox[0])) // 2, 20),
            txt,
            font=f,
            fill=(255, 255, 255),
        )

        # Some body lines so the page is not a flat colour
        for row in range(12):
            y = 220 + row * 70
            d.rectangle((60, y, args.width - 60, y + 26), fill=(58, 58, 68))

        name = f"{args.prefix}{i:03d}.jpg"
        img.save(out / name, quality=88)
        print(f"wrote {out / name}")


if __name__ == "__main__":
    main()
