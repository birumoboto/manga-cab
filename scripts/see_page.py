#!/usr/bin/env python3
"""Render a page (or a region of one) as ASCII, so the artwork can be seen.

Usage: python3 scripts/see_page.py <volume-id> <page-index> [cols]
"""
import json
import sys
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "_volumes"


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    volume_id = sys.argv[1]
    page_index = int(sys.argv[2])
    cols = int(sys.argv[3]) if len(sys.argv) > 3 else 110

    doc = json.loads(list((DATA / volume_id).glob("*.mokuro"))[0].read_text())
    page = doc["pages"][page_index]
    p = DATA / volume_id / "pages" / pathlib.Path(page.get("img_path", "")).name
    img = Image.open(p).convert("L")
    a = np.asarray(img).astype(int)

    H, W = a.shape
    rows = max(1, int(cols * H / W / 2.0))
    print(f"page {page_index}  {W}x{H}  -> {cols}x{rows}")
    for r in range(rows):
        line = ""
        for c in range(cols):
            best = 0
            for yy in range(int(r * H / rows), max(int(r * H / rows) + 1, int((r + 1) * H / rows))):
                for xx in range(int(c * W / cols), max(int(c * W / cols) + 1, int((c + 1) * W / cols))):
                    best = max(best, int(a[yy, xx]))
            line += " " if best > 205 else ("." if best > 155 else ("+" if best > 95 else ("#" if best > 45 else "@")))
        print(line)

    print("")
    for bi, blk in enumerate(page.get("blocks", [])):
        q = blk["lines_coords"][0]
        xs = [p2[0] for p2 in q]; ys = [p2[1] for p2 in q]
        print(f"  b{bi} {'VERT' if blk.get('vertical') else 'horz'} "
              f"({min(xs)},{min(ys)})-({max(xs)},{max(ys)}) "
              f"{max(xs)-min(xs)}x{max(ys)-min(ys)} fs={blk.get('font_size')} "
              f"text={blk['lines'][0][:30]!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
