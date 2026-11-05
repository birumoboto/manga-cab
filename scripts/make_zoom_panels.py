#!/usr/bin/env python3
"""Stitch the zoomed line crops into one comparison image per line.

Three panels, the same magnified region of the same line:

    1. the artwork's lettering
    2. the overlay's text alone
    3. the artwork with the overlay on top

Usage:
    python3 scripts/make_zoom_panels.py shots/zoom [out-dir]
"""

from __future__ import annotations

import json
import os
import sys

from PIL import Image, ImageDraw

PAD = 10
LABEL = 18
BG = (20, 20, 26)
FG = (240, 240, 245)


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else "shots/zoom"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else root
    os.makedirs(out_dir, exist_ok=True)

    manifest = json.load(open(os.path.join(root, "manifest.json")))
    for l in manifest["lines"]:
        tag = l["tag"]
        paths = [os.path.join(root, f"{tag}-{k}.png") for k in ("art", "ov", "both")]
        if not all(os.path.exists(p) for p in paths):
            continue
        imgs = [Image.open(p).convert("RGB") for p in paths]
        w, h = imgs[0].size

        out = Image.new("RGB", (w * 3 + PAD * 4, h + LABEL + PAD * 2), BG)
        draw = ImageDraw.Draw(out)
        labels = ["artwork", "overlay text", "artwork + overlay"]
        for i, (im, lab) in enumerate(zip(imgs, labels)):
            x = PAD * (i + 1) + w * i
            draw.text((x, 4), lab, fill=FG)
            out.paste(im, (x, LABEL))
            draw.rectangle([x, LABEL, x + w - 1, LABEL + h - 1], outline=(70, 70, 80))

        # A caption with the OCR text and which page it came from.
        cap = f"p{l['page']+1} {'VERT' if l['vertical'] else 'horz'}  {l['text'][:40]}"
        draw.text((PAD, LABEL + h + 4), cap, fill=(180, 180, 190))

        file = os.path.join(out_dir, f"zoom-{tag}.png")
        out.save(file)
        print(f"{file}  ({out.size[0]}x{out.size[1]})  {cap}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
