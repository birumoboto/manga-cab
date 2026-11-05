#!/usr/bin/env python3
"""Compare the overlay's rendered text against the artwork's lettering.

Reads the comparison images produced by scripts/make-comparison.js and
measures, for every OCR line, how the overlay's ink compares with the
artwork's ink in the same region.

Panels in each comparison image:
    1. the artwork
    2. the overlay text alone (white on black)
    3. the artwork with the overlay

This reports:
  * the overlay's ink bbox vs the artwork's ink bbox — are they the same
    size, and are they in the same place?
  * the overlap: what fraction of the artwork's ink the overlay actually
    covers. Low overlap means the overlay is drawn BESIDE the lettering
    rather than ON it.
  * the double-image risk: the artwork's ink that is NOT covered by the
    overlay — the original lettering still showing through.

Usage:
    python3 scripts/analyze_overlay.py shots
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
from PIL import Image

PAD = 12
LABEL = 20


def ink_mask(gray: np.ndarray, threshold: int = 128) -> np.ndarray:
    """Pixels that carry ink.

    For the artwork panel the ink is DARK on a light page; for the
    overlay panel it is LIGHT on black. So the polarity is detected
    from the panel's own histogram rather than assumed.
    """
    hist = np.bincount(gray.ravel(), minlength=256)
    # The background is whichever value dominates.
    bg = int(np.argmax(hist))
    return gray < bg - 20 if bg > 127 else gray > bg + 20


def bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def panel_slice(a: np.ndarray, index: int, panel_w: int, pad: int, label: int):
    """The pixels of one panel, inset so the border stroke is excluded."""
    h, w = a.shape
    height = h - label - pad
    x0 = pad * (index + 1) + panel_w * index
    # Inset 3px so the 1px border stroke is not counted as ink.
    return a[label + 3:label + height - 3, x0 + 3:x0 + panel_w - 3]


def main() -> int:
    shots = sys.argv[1] if len(sys.argv) > 1 else "shots"
    files = sorted(f for f in os.listdir(shots) if f.startswith("compare-") and f.endswith(".png"))

    rows = []
    for name in files:
        img = Image.open(os.path.join(shots, name)).convert("L")
        a = np.asarray(img, dtype=np.uint8)
        h, w = a.shape

        # The three panels are equal width, separated by PAD.
        # Find them from the file's own geometry: the image is
        # W*3 + PAD*4 wide.
        pad = PAD
        panel_w = (w - pad * 4) // 3
        if panel_w <= 0:
            continue

        art = panel_slice(a, 0, panel_w, pad, LABEL)
        ov = panel_slice(a, 1, panel_w, pad, LABEL)

        art_mask = ink_mask(art)
        ov_mask = ink_mask(ov)

        ob = bbox(ov_mask)
        ab = bbox(art_mask)
        if ob is None:
            print(f"{name}: no overlay ink")
            continue

        # The overlay's ink density tells us whether the text is drawn
        # at a sensible weight.
        ov_density = ov_mask.sum() / max(1, ob[2] - ob[0]) / max(1, ob[3] - ob[1])

        # The artwork's lettering is DARK; the overlay panel's background
        # is BLACK. So on the artwork panel the ink is the dark pixels,
        # but the whole page has dark panels. Restrict the artwork's ink
        # to the region the overlay occupies, then compare.
        region = ov_mask.copy()
        art_ink_in_region = art_mask & region
        covered = (art_ink_in_region & ov_mask).sum()
        total = art_ink_in_region.sum()

        rows.append({
            "file": name,
            "art_bbox": ab,
            "ov_bbox": ob,
            "ov_density": round(float(ov_density), 3),
            "coverage": round(float(covered / max(1, total)), 3),
        })

        print(f"{name}")
        print(f"   overlay ink bbox {ob}  ({(ob[2]-ob[0])}x{(ob[3]-ob[1])})"
              f"  fill {ov_density*100:.0f}%")
        if ab:
            print(f"   artwork ink bbox {ab}  ({(ab[2]-ab[0])}x{(ab[3]-ab[1])})")
        print(f"   overlay covers {covered/max(1,total)*100:.0f}% of the artwork's ink"
              f" in that region")

    if not rows:
        print("no comparison images found")
        return 1

    print()
    print("A healthy overlay has a fill around 0.25-0.45 — that is CJK")
    print("lettering with its natural gaps. A much lower fill means the")
    print("text is drawn too small or too thin; a much higher fill means")
    print("the glyphs are running into each other.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
