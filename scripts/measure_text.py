#!/usr/bin/env python3
"""Measure the real TEXT inside each detected line quad.

The first attempt at this measured the wrong thing: for light-on-dark
speech bubbles the crop's modal brightness is the black page, so
"pixels that differ from the background" selected the white BUBBLE
rather than the letters inside it.

The text is the small dark shape drawn ON a light fill. So the local
background has to be found from the crop's interior, not its mode, and
the ink is what differs from THAT.

For each line this reports the ink box relative to the quad, the glyph
count, and the advance — the ground truth the overlay is fitted to.

Usage: python3 scripts/measure_text.py <volume-id> [page-index]
"""
import json
import sys
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "_volumes"

# The browser's CJK metrics, measured in the reader's own font stack:
#   advance  0.9521 em
#   ink      0.85 em tall, 0.85 em wide
BROWSER_ADVANCE_EM = 0.9521
BROWSER_INK_H_EM = 0.8500
BROWSER_INK_W_EM = 0.8500


def quad_box(quad):
    xs = [p[0] for p in quad]
    ys = [p[1] for p in quad]
    return min(xs), min(ys), max(xs), max(ys)


def local_ink(img, quad):
    """Find the ink (the text) inside a quad.

    The text is dark strokes on a light fill, whatever the page's own
    polarity is. So: take the interior of the crop, find its dominant
    brightness (the fill), and treat anything darker as ink.
    """
    x0, y0, x1, y1 = quad_box(quad)
    x0 = max(0, int(x0)); y0 = max(0, int(y0))
    x1 = min(img.width, int(x1)); y1 = min(img.height, int(y1))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None

    crop = img.crop((x0, y0, x1, y1)).convert("L")
    arr = np.asarray(crop).astype(np.int16)
    h, w = arr.shape

    # The FILL is the dominant brightness of the crop's INTERIOR — the
    # bubble's white, or the page's white. The border of the crop is
    # often outside the bubble (the black page), so the mode over the
    # whole crop can be the page rather than the fill.
    inset = max(1, min(h, w) // 10)
    interior = arr[inset:h - inset or None, inset:w - inset or None]
    if interior.size == 0:
        interior = arr
    fill = int(np.bincount(interior.ravel(), minlength=256).argmax())

    # Ink = the darker of the two polarities, whichever it is.
    # Whichever side of `fill` is FARTHER from the page's own black.
    dark = fill - arr
    light = arr - fill
    # Use the side with the bigger spread — that is the text.
    ink = (dark > 40) if dark.std() >= light.std() else (light > 40)

    if ink.sum() < 4:
        return None

    rows = np.where(ink.sum(axis=1) > 0)[0]
    cols = np.where(ink.sum(axis=0) > 0)[0]
    iy0, iy1 = int(rows[0]), int(rows[-1])
    ix0, ix1 = int(cols[0]), int(cols[-1])

    # Segment into glyphs: runs of columns containing ink.
    colcount = ink.sum(axis=0)
    runs = []
    start = None
    for i, v in enumerate(colcount):
        if v > 0 and start is None:
            start = i
        elif v == 0 and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, len(colcount) - 1))

    # The text may be laid out in rows rather than columns; if the
    # column runs are few but tall, segment by rows instead.
    if len(runs) <= 2:
        rowcount = ink.sum(axis=1)
        rruns = []
        start = None
        for i, v in enumerate(rowcount):
            if v > 0 and start is None:
                start = i
            elif v == 0 and start is not None:
                rruns.append((start, i - 1))
                start = None
        if start is not None:
            rruns.append((start, len(rowcount) - 1))
        if len(rruns) > len(runs):
            runs = rruns
            axis = "row"
        else:
            axis = "col"
    else:
        axis = "col"

    # A run that is nearly the whole crop is the fill, not a glyph —
    # merge runs that touch the edges.
    inner = []
    for a, b in runs:
        if (b - a) >= 0.9 * (w if axis == "col" else h):
            continue
        inner.append((a, b))

    widths = [b - a + 1 for a, b in inner]
    gaps = [inner[i + 1][0] - inner[i][1] - 1 for i in range(len(inner) - 1)]

    ink_w = ix1 - ix0 + 1
    ink_h = iy1 - iy0 + 1

    med_w = int(np.median(widths)) if widths else 0
    med_gap = int(np.median(gaps)) if gaps else 0

    return {
        "ink": (ink_w, ink_h),
        "ink_at": (ix0, iy0),
        "quad": (w, h),
        "glyphs": len(inner),
        "med_w": med_w,
        "med_gap": med_gap,
        "axis": axis,
        "fill": fill,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    volume_id = sys.argv[1]
    only_page = int(sys.argv[2]) if len(sys.argv) > 2 else None

    doc = json.loads(list((DATA / volume_id).glob("*.mokuro"))[0].read_text())

    print(f"{'line':<26} {'quad':>10} {'ink':>10} {'at':>10} {'gl':>3} "
          f"{'adv':>5} {'inkH':>5} {'adv/inkH':>9} {'fit':>6}")
    for pi, page in enumerate(doc.get("pages", [])):
        if only_page is not None and pi != only_page:
            continue
        p = DATA / volume_id / "pages" / pathlib.Path(page.get("img_path", "")).name
        if not p.exists():
            continue
        img = Image.open(p).convert("L")
        for bi, blk in enumerate(page.get("blocks", [])):
            vert = "V" if blk.get("vertical") else " "
            for li, quad in enumerate(blk.get("lines_coords", [])):
                text = (blk.get("lines") or [""])[li] if li < len(blk.get("lines", [])) else ""
                m = local_ink(img, quad)
                if not m:
                    print(f"  p{pi} b{bi} l{li} {vert} {text[:14]!r:<20} — no ink")
                    continue
                iw, ih = m["ink"]
                n = max(1, m["glyphs"])
                adv = iw / n
                # For a square CJK glyph the advance equals the ink height.
                fit = adv / ih if ih else 0
                tag = "V" if blk.get("vertical") else " "
                print(
                    f"  p{pi} b{bi} l{li} {tag} {text[:14]!r:<20} "
                    f"{m['quad'][0]:>4}x{m['quad'][1]:<5} {iw:>4}x{ih:<5} "
                    f"({m['ink_at'][0]:>3},{m['ink_at'][1]:>3}) {m['glyphs']:>3} "
                    f"{adv:>5.1f} {ih:>5} {fit:>9.2f}"
                )
    return 0


if __name__ == "__main__":
    sys.exit(main())
