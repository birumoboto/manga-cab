#!/usr/bin/env python3
"""What is actually IN a vertical column, and which orientation reads it?

mokuro detects vertical text as COLUMNS. One detected "line" holds every
character stacked down the column. The column's height divided by its
width says how many characters should be in it.

mokuro's flow for a vertical line is:

    get_transformed_region()   warp the quad -> 64 wide x (64*ratio) tall,
                               then rotate 90 COUNTERCLOCKWISE
    manga_page_ocr.py          then rotate 90 CLOCKWISE before recognition

The two rotations cancel, so the recogniser is handed the column
UPRIGHT (a tall narrow strip). That is right for manga-ocr, which was
trained on upright vertical manga crops — but CnOCR is a general
scene-text recogniser and expects HORIZONTAL text.

This script renders the column in all three orientations and runs the
recogniser on each, so the right one can be picked from evidence.

Usage: python3 scripts/probe_vertical.py <volume-id> [page-index]
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


def warp_column(img, quad, textheight=64):
    """The crop exactly as mokuro's get_transformed_region makes it."""
    import cv2

    src = np.array(quad, dtype=np.float64)
    middle = (src[[1, 2, 3, 0]] + src) / 2
    vec_v = middle[2] - middle[0]
    vec_h = middle[1] - middle[3]
    ratio = np.linalg.norm(vec_v) / max(1e-9, np.linalg.norm(vec_h))

    w = int(textheight)
    h = int(round(textheight * ratio))
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)
    M, _ = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    region = cv2.warpPerspective(np.asarray(img), M, (w, h))
    return region


def ascii_strip(arr, cols=100):
    """Render a strip of text as ASCII, so the characters can be seen."""
    h, w = arr.shape[:2]
    rows = max(1, min(24, h // 8))
    out = []
    for r in range(rows):
        line = ""
        for c in range(cols):
            best = 0
            for yy in range(int(r * h / rows), max(int(r * h / rows) + 1, int((r + 1) * h / rows))):
                for xx in range(int(c * w / cols), max(int(c * w / cols) + 1, int((c + 1) * w / cols))):
                    best = max(best, int(arr[yy, xx]))
            line += " " if best > 200 else ("." if best > 150 else ("+" if best > 90 else ("#" if best > 40 else "@")))
        out.append(line)
    return out


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    volume_id = sys.argv[1]
    only_page = int(sys.argv[2]) if len(sys.argv) > 2 else None

    from mokuro.recognizers import build_recognizer  # noqa: E402
    import cv2  # noqa: E402

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
            img = np.asarray(Image.open(p).convert("L"))

            warped = warp_column(img, quad)          # 64 wide x tall
            ccw = cv2.rotate(warped, cv2.ROTATE_90_COUNTERCLOCKWISE)   # wide strip
            cw = cv2.rotate(warped, cv2.ROTATE_90_CLOCKWISE)           # upright

            x0, y0, x1, y1 = quad_box(quad)
            col_w, col_h = int(x1 - x0), int(y1 - y0)
            fs = blk.get("font_size") or col_w
            expect = max(1, round(col_h / max(1, fs)))

            print(f"p{pi} b{bi}  mokuro stored {blk['lines'][0]!r}")
            print(f"    column {col_w}x{col_h}  fs={fs}  -> ~{expect} characters fit down it")
            for name, arr in (("upright (what mokuro sends)", cw),
                              ("horizontal strip (CCW only)", ccw)):
                text = rec(Image.fromarray(arr))
                print(f"    {name:<34} -> {text!r}")
            print("    the horizontal strip reads:")
            for L in ascii_strip(ccw):
                print("      " + L)
            print("")
    return 0


if __name__ == "__main__":
    sys.exit(main())
