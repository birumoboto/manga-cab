#!/usr/bin/env python3
"""Print an ASCII ink map of a detector quad, oriented for reading.

For a HORIZONTAL line the map reads left-to-right as usual. For a
VERTICAL line the map is TRANSPOSED, so the column reads left-to-right
and down-the-column becomes left-to-right — which is how the text is
actually written.

Each cell is a block of the image, marked '#' where there is ink.

Usage:
    python3 scripts/see_quad.py <volume-id> <page-index> [block-index]
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
from PIL import Image

BASE = os.environ.get(
    "MANGA_VOLUMES",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "_volumes"),
)


def ink_mask(crop: np.ndarray) -> np.ndarray:
    """A boolean 2-D ink mask, polarity-agnostic.

    Deviation from each row's own median: a row of glyph strokes
    deviates a lot from the row's median, a blank bubble row does not.
    The row decision is broadcast back over the row's pixels, then
    the column profile is applied the same way to catch the strokes
    that sit in the middle of an otherwise blank row.
    """
    med = np.median(crop, axis=1, keepdims=True)
    prof = np.abs(crop - med).mean(axis=1)
    thr = max(6.0, prof.max() * 0.22)
    rows = prof > thr
    mask = np.repeat(rows[:, None], crop.shape[1], axis=1)

    # Also keep columns that carry ink, so a glyph whose stroke only
    # touches a few pixels is not dropped.
    cmed = np.median(crop, axis=0, keepdims=True)
    cprof = np.abs(crop - cmed).mean(axis=0)
    cthr = max(6.0, cprof.max() * 0.22)
    mask = mask & (cprof[None, :] > cthr)
    return mask


def main() -> int:
    vol = sys.argv[1]
    pidx = int(sys.argv[2])
    bidx = int(sys.argv[3]) if len(sys.argv) > 3 else None

    vdir = os.path.join(BASE, vol)
    doc = json.load(open(os.path.join(vdir, "pages.mokuro"), encoding="utf-8"))
    page = doc["pages"][pidx]

    img = None
    for cand in (page.get("img_path"), f"{pidx+1:03d}.webp", f"{pidx+1:03d}.jpg",
                 f"{pidx+1:03d}.png"):
        p = os.path.join(vdir, "pages", cand)
        if os.path.exists(p):
            img = Image.open(p).convert("L")
            break
    if img is None:
        print("no image found for", page.get("img_path"))
        return 1

    W, H = img.size
    print(f"volume={vol} page={pidx} image={W}x{H} ({page.get('img_path')})")

    for bi, blk in enumerate(page["blocks"]):
        if bidx is not None and bi != bidx:
            continue
        vert = bool(blk.get("vertical"))
        print("=" * 72)
        print(f"block {bi} vertical={vert} lines={blk.get('lines')}")
        for li, lc in enumerate(blk.get("lines_coords", [])):
            xs = [p[0] for p in lc]
            ys = [p[1] for p in lc]
            x0, x1 = int(min(xs)), int(max(xs))
            y0, y1 = int(min(ys)), int(max(ys))
            crop = np.asarray(img.crop((x0, y0, x1, y1)), dtype=float)

            rows = ink_mask(crop)
            idx = np.where(rows)[0]
            if len(idx) == 0:
                print(f"  line {li}: empty")
                continue
            top, bot = int(idx[0]), int(idx[-1]) + 1
            sub = crop[top:bot]
            mask = rows[top:bot]

            # For a vertical column, transpose so it reads left-to-right.
            if vert:
                mask = mask.T

            ch, cw = mask.shape
            rstep = max(1, ch // 44)
            cstep = max(1, cw // 90)
            # Collapse a band of rows by taking the max (any ink in the
            # band counts), so thin strokes survive the downsample.
            for r in range(0, ch, rstep):
                band = mask[r:r + rstep]
                cols = band.any(axis=0)
                print("    " + "".join("#" if cols[c] else "." for c in range(0, cw, cstep)))

            # How many glyph columns are there along the reading axis?
            cprof = np.abs(sub - np.median(sub, axis=1, keepdims=True)).mean(axis=0)
            cidx = np.where(cprof > max(6.0, cprof.max() * 0.22))[0]
            ncols = 0
            if len(cidx):
                ncols = 1
                for k in range(1, len(cidx)):
                    if cidx[k] - cidx[k - 1] > 4:
                        ncols += 1
            print(f"  line {li}: quad=({x0},{y0})-({x1},{y1}) {x1-x0}x{y1-y0}"
                  f"  ink {bot-top}px  glyph-columns={ncols}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
