#!/usr/bin/env python3
"""Measure the real rendered overlay against the real rendered artwork.

Uses the panel captures from scripts/capture-panels.js:
    pNN-art.png   the artwork, overlay hidden
    pNN-ov.png    the overlay alone, on black
    pNN-both.png  the artwork with the overlay on top

For every page it reports:

  SIZE   the overlay's ink extent vs the artwork's lettering extent
  PLACE  how far the overlay's ink origin is from the artwork's
  COVER  how much of the artwork's lettering the overlay actually sits
         on top of — a low number means the overlay is drawn BESIDE
         the lettering rather than ON it
  DOUBLE how much of the artwork's lettering is still visible through
         the overlay — the "double image" seen when they do not coincide

The artwork's lettering is found with the same ink measurement the
reader uses: deviation from each row's own median, which finds the
dark strokes whatever the page's background is.

Usage:
    python3 scripts/analyze_panels.py shots/panels
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
from PIL import Image


def load(path: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert("L"), dtype=np.uint8)


def artwork_ink(gray: np.ndarray) -> np.ndarray:
    """The artwork's dark strokes, found by row-median deviation.

    Polarity-agnostic: a row of strokes deviates from its own median, a
    blank row does not.
    """
    a = gray.astype(float)
    med = np.median(a, axis=1, keepdims=True)
    prof = np.abs(a - med).mean(axis=1)
    thr = max(8.0, prof.max() * 0.30)
    rows = prof > thr
    mask = np.repeat(rows[:, None], a.shape[1], axis=1)
    cmed = np.median(a, axis=0, keepdims=True)
    cprof = np.abs(a - cmed).mean(axis=0)
    cthr = max(8.0, cprof.max() * 0.30)
    return mask & (cprof[None, :] > cthr)


def overlay_ink(gray: np.ndarray) -> np.ndarray:
    """The overlay's light glyphs on its black background."""
    a = gray.astype(float)
    hist = np.bincount(a.ravel().astype(int), minlength=256)
    bg = int(np.argmax(hist))
    return a > bg + 25


def bbox(mask: np.ndarray):
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else "shots/panels"
    tags = sorted({f.split("-")[0] for f in os.listdir(root) if f.endswith("-art.png")})

    # The captures are viewport screenshots; the manifest records where
    # each page sat on screen, so the panels can be cropped to the page.
    manifest_path = os.path.join(root, "manifest.json")
    dsf = 2
    rects: dict[str, dict] = {}
    if os.path.exists(manifest_path):
        m = json.load(open(manifest_path))
        dsf = m.get("dsf", 2)
        for p in m.get("pages", []):
            rects[p["tag"]] = p["rect"]

    print(f"{'page':>5} {'overlay ink':>16} {'artwork ink':>16} "
          f"{'cover':>7} {'double':>7} {'dx':>6} {'dy':>6} {'size':>7}")
    print("-" * 82)

    summary = []
    for tag in tags:
        paths = [os.path.join(root, f"{tag}-{k}.png") for k in ("art", "ov", "both")]
        if not all(os.path.exists(p) for p in paths):
            continue
        art, ov, both = (load(p) for p in paths)

        # Crop to the page's on-screen rect (in device pixels).
        r = rects.get(tag) or rects.get(tag.lstrip("p"))
        if r:
            x0 = int(r["x"] * dsf)
            y0 = int(r["y"] * dsf)
            x1 = x0 + int(r["w"] * dsf)
            y1 = y0 + int(r["h"] * dsf)

            def crop(a, x0=x0, y0=y0, x1=x1, y1=y1):
                hh, ww = a.shape[:2]
                return a[max(0, y0):min(hh, y1), max(0, x0):min(ww, x1)]

            art, ov, both = crop(art), crop(ov), crop(both)

        h = min(art.shape[0], ov.shape[0], both.shape[0])
        w = min(art.shape[1], ov.shape[1], both.shape[1])
        art, ov, both = art[:h, :w], ov[:h, :w], both[:h, :w]

        ovm = overlay_ink(ov)
        artm = artwork_ink(art)

        ob = bbox(ovm)
        if ob is None:
            print(f"{tag[1:]:>5}  no overlay ink")
            continue

        # The artwork's lettering, restricted to the overlay's rows —
        # the rest of the page is panel artwork, not text.
        rows = slice(max(0, ob[1] - 40), min(artm.shape[0], ob[3] + 40))
        ab = bbox(artm[rows])
        if ab is None:
            print(f"{tag[1:]:>5}  no artwork ink near the overlay")
            continue
        ab = (ab[0], ab[1] + rows.start, ab[2], ab[3] + rows.start)

        # The overlay's own bounding region, expanded a little.
        region = np.zeros_like(artm)
        region[max(0, ob[1] - 12):ob[3] + 12,
               max(0, ob[0] - 12):ob[2] + 12] = True
        art_in = artm & region
        total = art_in.sum()
        if total == 0:
            print(f"{tag[1:]:>5}  the overlay sits on empty artwork")
            continue

        # Where the overlay's glyphs replaced the artwork's strokes, the
        # artwork panel is light and the "both" panel is bright white.
        replaced = (art.astype(int) > 120) & (ov.astype(int) > 120) & region
        covered = (replaced & art_in).sum()

        # The lettering still visible through the overlay: dark in the
        # artwork and still dark in "both".
        still = (both.astype(int) < art.astype(int) - 30) & art_in
        double = still.sum()

        dx = ob[0] - ab[0]
        dy = ob[1] - ab[1]
        size_ratio = (ob[2] - ob[0]) / max(1, ab[2] - ab[0])

        summary.append({
            "page": tag[1:], "cover": covered / max(1, total),
            "double": double / max(1, total), "dx": dx, "dy": dy,
            "size": size_ratio,
        })

        print(f"{tag[1:]:>5} {f'{ob[2]-ob[0]}x{ob[3]-ob[1]}':>16} "
              f"{f'{ab[2]-ab[0]}x{ab[3]-ab[1]}':>16} "
              f"{covered/max(1,total)*100:>6.0f}% {double/max(1,total)*100:>6.0f}% "
              f"{dx:>6} {dy:>6} {size_ratio:>6.2f}x")

    if summary:
        c = np.mean([s["cover"] for s in summary])
        d = np.mean([s["double"] for s in summary])
        sz = np.mean([s["size"] for s in summary])
        print()
        print(f"mean coverage {c*100:.0f}%   leftover lettering {d*100:.0f}%   "
              f"size ratio {sz:.2f}x")
        print()
        print("coverage = the overlay lands ON the artwork's lettering.")
        print("leftover = the original lettering still shows through (double image).")
        print("size     = the overlay's width vs the artwork's lettering width.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
