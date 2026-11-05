#!/usr/bin/env python3
"""Measure a line's text inside its quad — polarity-agnostic.

The earlier attempts failed because they guessed the polarity from the
crop's histogram. This one does not guess at all: for each row (or
column) it measures how much the pixels DEVIATE from that row's own
median. A row of glyph strokes deviates a lot; a blank row of speech
bubble deviates not at all. That works on a white bubble, a black page
and anything in between.

For each line it reports:
   inkH   the cross-axis extent of the text (the glyph height)
   n      how many characters are in it
   adv    the along-axis advance per character

Usage: python3 scripts/measure_ink2.py <volume-id> [page-index]
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


def dev_profile(arr, axis):
    """How much each row (axis=0) or column (axis=1) deviates from itself."""
    if axis == 0:
        med = np.median(arr, axis=1, keepdims=True)
        dev = np.abs(arr - med)
    else:
        med = np.median(arr, axis=0, keepdims=True)
        dev = np.abs(arr - med)
    prof = dev.mean(axis=1 - axis)
    return prof


def analyse(arr, quad, vertical):
    x0, y0, x1, y1 = (int(v) for v in quad_box(quad))
    crop = arr[y0:y1, x0:x1].astype(np.float64)
    h, w = crop.shape
    if h < 4 or w < 4:
        return None

    # Cross-axis: rows for horizontal text, columns for vertical.
    cross = dev_profile(crop, 0) if not vertical else dev_profile(crop, 1)
    along = dev_profile(crop, 1) if not vertical else dev_profile(crop, 0)

    # The text's extent along the cross axis: the rows/columns whose
    # deviation is a real share of the maximum.
    thr = max(1.0, cross.max() * 0.12)
    idx = np.where(cross > thr)[0]
    if len(idx) == 0:
        return None
    c_lo, c_hi = int(idx[0]), int(idx[-1])
    cross_extent = c_hi - c_lo + 1

    # Segment the characters along the text's own axis.
    athr = max(1.0, along.max() * 0.10)
    runs = []
    start = None
    for i, v in enumerate(along):
        if v > athr and start is None:
            start = i
        elif v <= athr and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, len(along) - 1))

    if len(runs) < 1:
        return None

    # Merge runs that are very close together — a single character often
    # splits into several strokes.
    if len(runs) > 1:
        merged = [runs[0]]
        for a, b in runs[1:]:
            if a - merged[-1][1] <= max(2, cross_extent * 0.12):
                merged[-1] = (merged[-1][0], b)
            else:
                merged.append((a, b))
        runs = merged

    widths = [b - a + 1 for a, b in runs]
    gaps = [runs[i + 1][0] - runs[i][1] - 1 for i in range(len(runs) - 1)]
    n = len(runs)
    along_extent = runs[-1][1] - runs[0][0] + 1
    med_gap = int(np.median(gaps)) if gaps else 0
    adv = (along_extent + med_gap) / n if n else 0

    return {
        "quad": (w, h),
        "cross": cross_extent,
        "n": n,
        "adv": adv,
        "med_w": int(np.median(widths)),
        "med_gap": med_gap,
        "at": (runs[0][0], c_lo),
        "along_extent": along_extent,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    volume_id = sys.argv[1]
    only_page = int(sys.argv[2]) if len(sys.argv) > 2 else None

    doc = json.loads(list((DATA / volume_id).glob("*.mokuro"))[0].read_text())

    print(f"{'line':<30} {'quad':>10} {'inkH':>5} {'n':>3} {'adv':>6} "
          f"{'adv/inkH':>8} {'mokuro chars':>12}")
    for pi, page in enumerate(doc.get("pages", [])):
        if only_page is not None and pi != only_page:
            continue
        p = DATA / volume_id / "pages" / pathlib.Path(page.get("img_path", "")).name
        if not p.exists():
            continue
        arr = np.asarray(Image.open(p).convert("L"))
        for bi, blk in enumerate(page.get("blocks", [])):
            vertical = bool(blk.get("vertical"))
            for li, quad in enumerate(blk.get("lines_coords", [])):
                text = (blk.get("lines") or [""])[li] if li < len(blk.get("lines", [])) else ""
                m = analyse(arr, quad, vertical)
                tag = "V" if vertical else " "
                if not m:
                    print(f"  p{pi} b{bi} l{li} {tag} {text[:16]!r:<22} — no ink")
                    continue
                fit = m["adv"] / m["cross"] if m["cross"] else 0
                print(
                    f"  p{pi} b{bi} l{li} {tag} {text[:16]!r:<22} "
                    f"{m['quad'][0]:>4}x{m['quad'][1]:<5} {m['cross']:>5} {m['n']:>3} "
                    f"{m['adv']:>6.1f} {fit:>8.2f} {len(text):>12}"
                )
    return 0


if __name__ == "__main__":
    sys.exit(main())
