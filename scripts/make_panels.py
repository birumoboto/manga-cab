#!/usr/bin/env python3
"""Stitch the panel captures into one comparison image per page.

Three panels side by side, the same crop of the same region:

    1. the artwork
    2. the overlay text alone (on black)
    3. the artwork with the overlay on top

Usage:
    python3 scripts/make_panels.py shots/panels [out-dir]
"""

from __future__ import annotations

import json
import os
import sys

from PIL import Image, ImageDraw

PAD = 12
LABEL = 20
BG = (22, 22, 28)
FG = (235, 235, 240)


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else "shots/panels"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else root

    manifest_path = os.path.join(root, "manifest.json")
    dsf = 2
    if os.path.exists(manifest_path):
        dsf = json.load(open(manifest_path)).get("dsf", 2)

    tags = sorted({f.split("-")[0] for f in os.listdir(root) if f.endswith("-art.png")})
    os.makedirs(out_dir, exist_ok=True)

    for tag in tags:
        arts = [os.path.join(root, f"{tag}-{k}.png") for k in ("art", "ov", "both")]
        if not all(os.path.exists(p) for p in arts):
            continue
        imgs = [Image.open(p).convert("RGB") for p in arts]
        w, h = imgs[0].size

        out = Image.new("RGB", (w * 3 + PAD * 4, h + LABEL + PAD * 2), BG)
        draw = ImageDraw.Draw(out)

        labels = ["1. artwork", "2. overlay text alone", "3. artwork + overlay"]
        for i, (im, lab) in enumerate(zip(imgs, labels)):
            x = PAD * (i + 1) + w * i
            draw.text((x, 5), lab, fill=FG)
            out.paste(im, (x, LABEL))
            draw.rectangle([x, LABEL, x + w - 1, LABEL + h - 1], outline=(60, 60, 70))

        file = os.path.join(out_dir, f"cmp-{tag[1:]}.png")
        out.save(file)
        print(f"{file}  ({w*3+PAD*4}x{h+LABEL+PAD*2})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
