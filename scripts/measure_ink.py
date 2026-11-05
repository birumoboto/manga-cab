#!/usr/bin/env python3
"""Measure the real ink inside each detected text quad.

The overlay has to look like the artwork. The only honest reference is
the artwork itself: for every detected line quad, find the ink inside it
and report how big the glyphs actually are and where they sit.

This is the ground truth for fitting the overlay text.

Usage: python3 scripts/measure_ink.py <volume-id> [page-index]
"""
import json
import sys
import pathlib

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "_volumes"


def load_mokuro(volume_id):
    p = DATA / volume_id / "volume.json"
    meta = json.loads(p.read_text())
    return meta


def mokuro_path(volume_id):
    return DATA / volume_id / "volume.json"


def ink_in_quad(img, quad, pad=2):
    """Return the ink bbox inside a quad, in image pixels.

    The quad is [[x,y],...]. We crop it, convert to greyscale, and find
    the pixels that differ strongly from the local background.
    """
    xs = [int(p[0]) for p in quad]
    ys = [int(p[1]) for p in quad]
    x0, x1 = max(0, min(xs) - pad), min(img.width, max(xs) + pad)
    y0, y1 = max(0, min(ys) - pad), min(img.height, max(ys) + pad)
    if x1 <= x0 or y1 <= y0:
        return None

    crop = img.crop((x0, y0, x1, y1)).convert("L")
    w, h = crop.size
    px = crop.load()

    # The background is the most common brightness in the crop.
    hist = [0] * 256
    for yy in range(h):
        for xx in range(w):
            hist[px[xx, yy]] += 1
    bg = max(range(256), key=lambda i: hist[i])

    # Ink = pixels far from the background.
    thr = 45
    left, right, top, bottom = None, None, None, None
    for yy in range(h):
        for xx in range(w):
            if abs(px[xx, yy] - bg) > thr:
                if left is None or xx < left:
                    left = xx
                if right is None or xx > right:
                    right = xx
                if top is None or yy < top:
                    top = yy
                if bottom is None or yy > bottom:
                    bottom = yy

    if left is None or right is None or top is None or bottom is None:
        return None
    return {
        "x": x0 + int(left), "y": y0 + int(top),
        "w": int(right) - int(left) + 1, "h": int(bottom) - int(top) + 1,
        "quad": (x0, y0, x1, y1),
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    volume_id = sys.argv[1]
    only_page = int(sys.argv[2]) if len(sys.argv) > 2 else None

    meta = mokuro_path(volume_id).parent / "ocr.mokuro"
    # The attached OCR data lives next to volume.json.
    candidates = list((DATA / volume_id).glob("*.mokuro"))
    if not candidates:
        print("no .mokuro found in", DATA / volume_id)
        return 1
    doc = json.loads(candidates[0].read_text())

    for pi, page in enumerate(doc.get("pages", [])):
        if only_page is not None and pi != only_page:
            continue
        img_path = DATA / volume_id / "pages" / pathlib.Path(page.get("img_path", "")).name
        if not img_path.exists():
            continue
        img = Image.open(img_path).convert("L")
        print(f"\n=== page {pi}  {img.width}x{img.height} ===")
        for bi, blk in enumerate(page.get("blocks", [])):
            for li, quad in enumerate(blk.get("lines_coords", [])):
                ink = ink_in_quad(img, quad)
                text = (blk.get("lines") or [""])[li] if li < len(blk.get("lines", [])) else ""
                if not ink:
                    print(f"  b{bi} l{li} \"{text[:16]}\" — no ink found")
                    continue
                qx0 = min(p[0] for p in quad)
                qx1 = max(p[0] for p in quad)
                qy0 = min(p[1] for p in quad)
                qy1 = max(p[1] for p in quad)
                print(
                    f"  b{bi} l{li} \"{text[:16]:<16}\" "
                    f"quad={qx1-qx0:>4}x{qy1-qy0:<4} "
                    f"ink={ink['w']:>4}x{ink['h']:<4} at "
                    f"({ink['x']-qx0:+4},{ink['y']-qy0:+4}) "
                    f"fs={blk.get('font_size')}"
                )
    return 0


if __name__ == "__main__":
    sys.exit(main())
