#!/usr/bin/env python3
"""Measure the artwork's real glyph metrics.

The overlay has to look like the lettering that is already in the page.
A bounding box tells us the line's extent, but not the glyphs' shape or
spacing — and that is what decides whether the overlay text looks
stretched or overlapping.

For every detected line this reports:

  polarity   is the text light-on-dark or dark-on-light
  advance    the typical distance between glyph starts
  gap        the typical space between glyphs
  ink        the glyph's own width and height
  aspect     ink width / ink height  (1.0 = a square glyph)

Usage: python3 scripts/measure_glyphs.py <volume-id> [page-index]
"""
import json
import sys
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "_volumes"


def load_doc(volume_id):
    candidates = list((DATA / volume_id).glob("*.mokuro"))
    if not candidates:
        raise SystemExit(f"no .mokuro found in {DATA / volume_id}")
    return json.loads(candidates[0].read_text())


def quad_box(quad):
    xs = [p[0] for p in quad]
    ys = [p[1] for p in quad]
    return min(xs), min(ys), max(xs), max(ys)


def analyse(img, quad):
    """Segment the ink inside a quad into glyphs and measure them."""
    x0, y0, x1, y1 = quad_box(quad)
    x0 = max(0, int(x0)); y0 = max(0, int(y0))
    x1 = min(img.width, int(x1)); y1 = min(img.height, int(y1))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None

    crop = img.crop((x0, y0, x1, y1)).convert("L")
    arr = np.asarray(crop).astype(np.int16)

    # ── Polarity: the text is either darker or lighter than the page.
    hist = np.bincount(arr.ravel(), minlength=256)
    bg = int(np.argmax(hist))
    # Ink = pixels far from the background.
    dist = np.abs(arr - bg)
    ink = dist > 45
    if ink.sum() == 0:
        return None
    polarity = "dark-on-light" if bg > 127 else "light-on-dark"

    rows = ink.sum(axis=1)
    cols = ink.sum(axis=0)
    ry = np.where(rows > 0)[0]
    cx = np.where(cols > 0)[0]
    ink_x0, ink_x1 = int(cx[0]), int(cx[-1])
    ink_y0, ink_y1 = int(ry[0]), int(ry[-1])

    # ── Segment the glyphs: runs of columns that contain ink.
    # A gap is a run of empty columns; a gap wider than a third of the
    # typical gap is a space, a narrower one is just letter spacing.
    runs = []
    start = None
    for i, v in enumerate(cols):
        if v > 0 and start is None:
            start = i
        elif v == 0 and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, len(cols) - 1))

    if not runs:
        return None

    widths = [b - a + 1 for a, b in runs]
    gaps = [runs[i + 1][0] - runs[i][1] - 1 for i in range(len(runs) - 1)]

    # The glyph height is measured from the whole line's ink, but a
    # bracket or a full stop is short — so take the height of the
    # TALLEST run in the row band, which is the CJK body height.
    heights = []
    for a, b in runs:
        band = ink[:, a:b + 1]
        r = np.where(band.sum(axis=1) > 0)[0]
        if len(r):
            heights.append(int(r[-1] - r[0] + 1))

    med_w = int(np.median(widths)) if widths else 0
    med_h = int(np.median(heights)) if heights else 0
    med_gap = int(np.median(gaps)) if gaps else 0

    return {
        "polarity": polarity,
        "quad": (x1 - x0, y1 - y0),
        "ink": (ink_x1 - ink_x0 + 1, ink_y1 - ink_y0 + 1),
        "glyphs": len(runs),
        "med_w": med_w,
        "med_h": med_h,
        "med_gap": med_gap,
        "advance": med_w + med_gap,
        "aspect": round(med_w / med_h, 3) if med_h else 0,
        "fills": round((ink_x1 - ink_x0 + 1) / max(1, x1 - x0), 3),
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    volume_id = sys.argv[1]
    only_page = int(sys.argv[2]) if len(sys.argv) > 2 else None

    doc = load_doc(volume_id)
    for pi, page in enumerate(doc.get("pages", [])):
        if only_page is not None and pi != only_page:
            continue
        p = DATA / volume_id / "pages" / pathlib.Path(page.get("img_path", "")).name
        if not p.exists():
            continue
        img = Image.open(p).convert("L")
        for bi, blk in enumerate(page.get("blocks", [])):
            vert = blk.get("vertical")
            fs = blk.get("font_size")
            for li, quad in enumerate(blk.get("lines_coords", [])):
                text = (blk.get("lines") or [""])[li] if li < len(blk.get("lines", [])) else ""
                m = analyse(img, quad)
                if not m:
                    print(f"  p{pi} b{bi} l{li} {text[:12]!r:<16} — no ink")
                    continue
                tag = "VERT" if vert else "horz"
                print(
                    f"  p{pi} b{bi} l{li} {tag} {text[:12]!r:<16} "
                    f"quad={m['quad'][0]}x{m['quad'][1]:<4} ink={m['ink'][0]}x{m['ink'][1]:<4} "
                    f"glyphs={m['glyphs']:<3} w={m['med_w']:<3} h={m['med_h']:<3} "
                    f"gap={m['med_gap']:<3} adv={m['advance']:<4} "
                    f"aspect={m['aspect']:<6} fills={m['fills']:<6} fs={fs} {m['polarity']}"
                )
    return 0


if __name__ == "__main__":
    sys.exit(main())
