#!/usr/bin/env python3
"""What IS in a vertical column, and can it be read?

mokuro detects vertical text as COLUMNS: one detected "line" holds every
character stacked down the column. For this volume it stored ONE
character for columns that are several glyph-widths tall — and the
recogniser's output on the rotated crop was garbage.

This tries four ways of reading the column:

   raw-ccw   the quad cropped straight, rotated so it lies horizontally
   raw-cw     the same, rotated the other way
   homography mokuro's own warp, then rotated so it lies horizontally
   per-cell   the column split into square cells, one per character

so it is clear whether the column holds readable text at all, and which
way round it wants to be read.

Usage: python3 scripts/probe_vcells.py <volume-id> [page-index]
"""
import json
import sys
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "_volumes"
MOKURO = pathlib.Path("/Users/bing/mokuro")

sys.path.insert(0, str(MOKURO))


def quad_box(quad):
    xs = [p[0] for p in quad]
    ys = [p[1] for p in quad]
    return min(xs), min(ys), max(xs), max(ys)


def homography_crop(arr, quad, textheight=64):
    import cv2

    src = np.array(quad, dtype=np.float64)
    middle = (src[[1, 2, 3, 0]] + src) / 2
    ratio = np.linalg.norm(middle[2] - middle[0]) / max(1e-9, np.linalg.norm(middle[1] - middle[3]))
    w = int(textheight)
    h = int(round(textheight * ratio))
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)
    M, _ = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    return cv2.warpPerspective(arr, M, (w, h))


def ink_extent(arr, vertical):
    """How far the text extends along the cross axis, in pixels.

    Uses each row's (or column's) deviation from its own median, so it
    does not care whether the text is dark on light or light on dark.
    """
    a = arr.astype(np.float64)
    if vertical:
        prof = np.abs(a - np.median(a, axis=0, keepdims=True)).mean(axis=0)
    else:
        prof = np.abs(a - np.median(a, axis=1, keepdims=True)).mean(axis=1)
    thr = max(1.0, prof.max() * 0.12)
    idx = np.where(prof > thr)[0]
    if len(idx) == 0:
        return None
    return int(idx[0]), int(idx[-1])


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    volume_id = sys.argv[1]
    only_page = int(sys.argv[2]) if len(sys.argv) > 2 else None

    import cv2  # noqa: E402
    from mokuro.recognizers import build_recognizer  # noqa: E402

    doc = json.loads(list((DATA / volume_id).glob("*.mokuro"))[0].read_text())
    rec = build_recognizer("cnocr")

    for pi, page in enumerate(doc.get("pages", [])):
        if only_page is not None and pi != only_page:
            continue
        for bi, blk in enumerate(page.get("blocks", [])):
            if not blk.get("vertical"):
                continue
            quad = blk["lines_coords"][0]
            p = DATA / volume_id / "pages" / pathlib.Path(page.get("img_path", "")).name
            rgb = np.asarray(Image.open(p).convert("RGB"))
            gray = np.asarray(Image.open(p).convert("L"))

            x0, y0, x1, y1 = (int(v) for v in quad_box(quad))
            raw = rgb[y0:y1, x0:x1]

            # The text's own extent inside the quad.
            ext = ink_extent(gray[y0:y1, x0:x1], vertical=True)
            if ext is None:
                print(f"p{pi} b{bi}: no ink")
                continue
            cross_lo, cross_hi = ext
            cross = cross_hi - cross_lo + 1
            along = y1 - y0

            print(f"p{pi} b{bi}  mokuro stored {blk['lines'][0]!r}")
            print(f"    quad {x1-x0}x{y1-y0}   text cross-extent {cross}px   "
                  f"-> {along / max(1, cross):.1f} glyphs down the column")

            variants = {
                "raw-ccw": cv2.rotate(raw, cv2.ROTATE_90_COUNTERCLOCKWISE),
                "raw-cw": cv2.rotate(raw, cv2.ROTATE_90_CLOCKWISE),
                "homography": cv2.rotate(homography_crop(rgb, quad), cv2.ROTATE_90_COUNTERCLOCKWISE),
            }
            for name, arr in variants.items():
                text = rec(Image.fromarray(arr))
                print(f"    {name:<12} -> {text!r}")

            # Per cell: split the column into square cells.
            n = max(1, round(along / max(1, cross)))
            print(f"    per-cell    -> ", end="")
            chars = []
            for k in range(n):
                cy0 = y0 + k * cross
                cy1 = min(y1, cy0 + cross)
                if cy1 - cy0 < cross * 0.5:
                    break
                cell = rgb[cy0:cy1, x0:x1]
                chars.append(rec(Image.fromarray(cell)))
            print("".join(chars))
            print("")
    return 0


if __name__ == "__main__":
    sys.exit(main())
