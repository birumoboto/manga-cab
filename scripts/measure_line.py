#!/usr/bin/env python3
"""Measure a line's REAL text inside its detected quad.

Two earlier attempts got this wrong, so this one is careful:

  * The crop's modal brightness is often the PAGE (black), not the
    speech bubble's white. So the background has to come from the
    crop's interior, and the ink is whichever polarity is the minority.

  * The quad mokuro detects is a polygon around the TEXT, but it also
    clips the bubble's edges. So the text's own extent is found by
    looking at the ink's core, not the crop's edges.

For each line this reports the text's box relative to the quad, how many
characters are in it, their advance, and — the number that decides
everything — the advance divided by the ink height. A square CJK glyph
has advance == ink height; below 1.0 means the lettering is condensed.

Usage: python3 scripts/measure_line.py <volume-id> [page-index]
"""
import json
import sys
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "_volumes"


def quad_box(quad):
    xs = [p[0] for p in quad]
    ys = [p[1] for p in quad]
    return min(xs), min(ys), max(xs), max(ys)


def text_ink(arr):
    """Return (mask, fill) for the text inside a crop.

    The text is a minority shape drawn on a background. Whichever
    polarity is the minority is the text.
    """
    h, w = arr.shape

    # The background: the dominant brightness of the crop's INTERIOR.
    inset = max(2, min(h, w) // 8)
    interior = arr[inset:h - inset or None, inset:w - inset or None]
    if interior.size == 0:
        interior = arr
    fill = int(np.bincount(interior.ravel(), minlength=256).argmax())

    dark = (arr < fill - 40)
    light = (arr > fill + 40)
    dark_frac = dark.mean()
    light_frac = light.mean()

    # The text is the minority polarity. If both are close, the crop is
    # mostly text — take whichever is smaller.
    if dark_frac <= light_frac:
        return dark, fill, "dark"
    return light, fill, "light"


def segment(mask, axis):
    """Runs of the mask along `axis` ('col' = characters side by side)."""
    profile = mask.sum(axis=0) if axis == "col" else mask.sum(axis=1)
    runs = []
    start = None
    for i, v in enumerate(profile):
        if v > 0 and start is None:
            start = i
        elif v == 0 and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, len(profile) - 1))
    return runs


def analyse(arr, quad):
    x0, y0, x1, y1 = (int(v) for v in quad_box(quad))
    crop = arr[y0:y1, x0:x1]
    if crop.shape[0] < 4 or crop.shape[1] < 4:
        return None
    mask, fill, polarity = text_ink(crop)
    if mask.sum() < 4:
        return None

    # Drop the border rows/columns: the bubble's outline is not text.
    # Keep only the rows/columns that hold a decent share of the ink.
    rowp = mask.sum(axis=1)
    colp = mask.sum(axis=0)
    rows = np.where(rowp > 0)[0]
    cols = np.where(colp > 0)[0]
    iy0, iy1 = int(rows[0]), int(rows[-1])
    ix0, ix1 = int(cols[0]), int(cols[-1])

    # The CORE: rows and columns where the ink is dense. The bubble
    # outline is a thin line, so it has a low density compared with a
    # stroke of a glyph.
    dense_rows = np.where(rowp >= max(2, rowp.max() * 0.35))[0]
    dense_cols = np.where(colp >= max(2, colp.max() * 0.35))[0]
    if len(dense_rows) == 0 or len(dense_cols) == 0:
        return None
    dy0, dy1 = int(dense_rows[0]), int(dense_rows[-1])
    dx0, dx1 = int(dense_cols[0]), int(dense_cols[-1])

    # Segment the core into characters.
    core = mask[dy0:dy1 + 1, dx0:dx1 + 1]
    runs = segment(core, "col")
    if len(runs) < 2:
        runs = segment(core, "row")
        if len(runs) < 2:
            return None
        axis = "row"
    else:
        axis = "col"

    widths = [b - a + 1 for a, b in runs]
    gaps = [runs[i + 1][0] - runs[i][1] - 1 for i in range(len(runs) - 1)]
    ink_w = (dx1 - dx0 + 1) if axis == "col" else (dy1 - dy0 + 1)
    ink_h = (dy1 - dy0 + 1) if axis == "col" else (dx1 - dx0 + 1)

    med_w = int(np.median(widths))
    med_gap = int(np.median(gaps)) if gaps else 0
    n = len(runs)
    advance = (ink_w + med_gap) / n

    return {
        "quad": (crop.shape[1], crop.shape[0]),
        "ink": (ink_w, ink_h),
        "core_at": (dx0, dy0),
        "n": n,
        "med_w": med_w,
        "med_gap": med_gap,
        "advance": advance,
        "aspect": round(advance / ink_h, 3) if ink_h else 0,
        "axis": axis,
        "polarity": polarity,
        "fill": fill,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    volume_id = sys.argv[1]
    only_page = int(sys.argv[2]) if len(sys.argv) > 2 else None

    doc = json.loads(list((DATA / volume_id).glob("*.mokuro"))[0].read_text())

    print(f"{'line':<28} {'quad':>10} {'text':>10} {'at':>10} {'n':>3} "
          f"{'adv':>6} {'inkH':>5} {'adv/inkH':>9}")
    for pi, page in enumerate(doc.get("pages", [])):
        if only_page is not None and pi != only_page:
            continue
        p = DATA / volume_id / "pages" / pathlib.Path(page.get("img_path", "")).name
        if not p.exists():
            continue
        arr = np.asarray(Image.open(p).convert("L")).astype(np.int16)
        for bi, blk in enumerate(page.get("blocks", [])):
            for li, quad in enumerate(blk.get("lines_coords", [])):
                text = (blk.get("lines") or [""])[li] if li < len(blk.get("lines", [])) else ""
                m = analyse(arr, quad)
                tag = "V" if blk.get("vertical") else " "
                if not m:
                    print(f"  p{pi} b{bi} l{li} {tag} {text[:14]!r:<20} — no ink")
                    continue
                iw, ih = m["ink"]
                print(
                    f"  p{pi} b{bi} l{li} {tag} {text[:14]!r:<20} "
                    f"{m['quad'][0]:>4}x{m['quad'][1]:<5} {iw:>4}x{ih:<5} "
                    f"({m['core_at'][0]:>3},{m['core_at'][1]:>3}) {m['n']:>3} "
                    f"{m['advance']:>6.1f} {ih:>5} {m['aspect']:>9.2f}"
                )
    return 0


if __name__ == "__main__":
    sys.exit(main())
