// ═══════════════════════════════════════════════════════════════
// Ink metrics — measure the artwork's real lettering geometry.
//
// mokuro's `font_size` is NOT the glyph size. From
// comic_text_detector/utils/textblock.py::examine_textblk():
//
//     vertical  -> font_size = norm_h / len(lines)   (the line's WIDTH)
//     horizontal-> font_size = norm_v / len(lines)   (the line's HEIGHT)
//
// So for a single-line block it is the QUAD's cross-axis size — and the
// quad also contains the speech bubble's edges and the page around the
// lettering. Fitting the overlay to the quad makes the text ~40% too
// big.
//
// This module measures the INK inside each detected quad so the overlay
// can be fitted to the lettering itself. It runs in the browser, on the
// very pixels the reader is showing, using a canvas.
//
// The measurement is polarity-agnostic: it compares each row (or
// column) against its own median, so it works on a white speech bubble
// on a black page and on black text on white.
//
// Run: node scripts/measure_ink.js <volume-id>
// ═══════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import { PNG } from "pngjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data", "_volumes");

/** The browser's CJK metrics, measured in the reader's own font stack. */
export const BROWSER = {
  /** The advance per character, as a fraction of the font size. */
  advance: 0.9521,
  /** The ink height of a glyph, as a fraction of the font size. */
  inkHeight: 0.85,
  /** The ink width of a glyph, as a fraction of the font size. */
  inkWidth: 0.85,
};

/**
 * Measure the ink inside a quad in a greyscale image.
 *
 * `quad` is [[x,y], ...] in image pixels. `vertical` says which way the
 * text runs.
 *
 * Returns null when there is no ink to measure.
 */
export function measureInk(gray, width, height, quad, vertical) {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(width, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(height, Math.ceil(Math.max(...ys)));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 4 || h < 4) return null;

  // ── Deviation of each row (or column) from its own median.
  //
  // A row of glyph strokes deviates a lot from its own median; a blank
  // row of speech bubble does not. This works whatever the polarity.
  const crossLen = vertical ? w : h;
  const alongLen = vertical ? h : w;

  // Cross-axis profile: rows for horizontal text, columns for vertical.
  const crossProfile = new Float64Array(crossLen);
  const alongProfile = new Float64Array(alongLen);

  // The median of each cross-axis slice, computed with a histogram so
  // this stays fast on big images.
  const hist = new Uint32Array(256);
  for (let c = 0; c < crossLen; c++) {
    hist.fill(0);
    for (let a = 0; a < alongLen; a++) {
      const v = gray[c * width + a];
      hist[v]++;
    }
    // The median value.
    let total = 0;
    let median = 128;
    for (let v = 0; v < 256; v++) {
      total += hist[v];
      if (total * 2 >= alongLen) { median = v; break; }
    }
    let dev = 0;
    for (let a = 0; a < alongLen; a++) {
      dev += Math.abs(gray[c * width + a] - median);
    }
    crossProfile[c] = dev / alongLen;
  }

  // Along-axis profile: columns for horizontal text, rows for vertical.
  {
    const slice = new Uint8Array(crossLen);
    for (let a = 0; a < alongLen; a++) {
      hist.fill(0);
      for (let c = 0; c < crossLen; c++) {
        const v = vertical
          ? gray[c * width + a]
          : gray[a * width + c];
        hist[v]++;
      }
      let total = 0;
      let median = 128;
      for (let v = 0; v < 256; v++) {
        total += hist[v];
        if (total * 2 >= crossLen) { median = v; break; }
      }
      let dev = 0;
      for (let c = 0; c < crossLen; c++) {
        const v = vertical
          ? gray[c * width + a]
          : gray[a * width + c];
        dev += Math.abs(v - median);
      }
      alongProfile[a] = dev / crossLen;
    }
  }

  const maxCross = Math.max(...crossProfile);
  const maxAlong = Math.max(...alongProfile);
  if (maxCross <= 0 || maxAlong <= 0) return null;

  // The text's extent along the cross axis.
  const cThr = Math.max(0.6, maxCross * 0.12);
  let cLo = -1, cHi = -1;
  for (let i = 0; i < crossLen; i++) {
    if (crossProfile[i] > cThr) {
      if (cLo < 0) cLo = i;
      cHi = i;
    }
  }
  if (cLo < 0) return null;
  const crossExtent = cHi - cLo + 1;

  // Segment the characters along the text's own axis.
  const aThr = Math.max(0.6, maxAlong * 0.10);
  const runs = [];
  let start = -1;
  for (let i = 0; i < alongLen; i++) {
    if (alongProfile[i] > aThr) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, alongLen - 1]);
  if (!runs.length) return null;

  // Merge runs that nearly touch — one character often breaks into
  // several strokes.
  const merged = [runs[0]];
  for (let i = 1; i < runs.length; i++) {
    const gap = runs[i][0] - merged[merged.length - 1][1];
    if (gap <= Math.max(2, crossExtent * 0.12)) {
      merged[merged.length - 1][1] = runs[i][1];
    } else {
      merged.push(runs[i]);
    }
  }

  const gaps = [];
  for (let i = 1; i < merged.length; i++) {
    gaps.push(merged[i][0] - merged[i - 1][1] - 1);
  }
  gaps.sort((a, b) => a - b);
  const medGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;

  const alongExtent = merged[merged.length - 1][1] - merged[0][0] + 1;
  const count = merged.length;

  return {
    /** The ink's extent along the cross axis — the glyph height. */
    crossExtent,
    /** The ink's extent along the text's own axis. */
    alongExtent,
    /** How many characters the segmentation found. */
    count,
    /** The typical gap between characters. */
    gap: medGap,
    /** Where the ink starts, relative to the quad. */
    offset: vertical ? { x: cLo, y: merged[0][0] } : { x: merged[0][0], y: cLo },
    /** The advance per character. */
    advance: count ? (alongExtent + medGap) / count : 0,
  };
}

/** Read a greyscale PNG into a flat byte array. */
export function readGray(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const gray = new Uint8Array(png.width * png.height);
  for (let i = 0, p = 0; i < png.data.length; i += 4, p++) {
    gray[p] = (png.data[i] * 77 + png.data[i + 1] * 150 + png.data[i + 2] * 29) >> 8;
  }
  return { gray, width: png.width, height: png.height };
}

/** Measure every line of a volume and print the results. */
function main() {
  const volumeId = process.argv[2];
  if (!volumeId) {
    console.log("usage: node scripts/measure_ink.js <volume-id>");
    return 1;
  }
  const dir = path.join(DATA, volumeId);
  const mokuroFile = fs.readdirSync(dir).find((f) => f.endsWith(".mokuro"));
  if (!mokuroFile) {
    console.log("no .mokuro in", dir);
    return 1;
  }
  const doc = JSON.parse(fs.readFileSync(path.join(dir, mokuroFile), "utf8"));

  console.log(
    "line".padEnd(30) + "quad".padStart(10) + "inkH".padStart(5) +
    "n".padStart(3) + "adv".padStart(6) + "adv/inkH".padStart(9) + "fs".padStart(6)
  );
  for (let pi = 0; pi < doc.pages.length; pi++) {
    const page = doc.pages[pi];
    const file = path.join(dir, "pages", path.basename(page.img_path));
    if (!fs.existsSync(file)) continue;
    const { gray, width, height } = readGray(file);
    for (let bi = 0; bi < (page.blocks || []).length; bi++) {
      const blk = page.blocks[bi];
      for (let li = 0; li < (blk.lines_coords || []).length; li++) {
        const m = measureInk(gray, width, height, blk.lines_coords[li], !!blk.vertical);
        const text = (blk.lines || [])[li] || "";
        if (!m) {
          console.log(`  p${pi} b${bi} l${li} ${blk.vertical ? "V" : " "} ${text.slice(0, 16)} — no ink`);
          continue;
        }
        const fit = m.advance / m.crossExtent;
        console.log(
          `  p${pi} b${bi} l${li} ${blk.vertical ? "V" : " "} ${text.slice(0, 16).padEnd(18)} ` +
          `${m.crossExtent.toString().padStart(5)} ${String(m.count).padStart(3)} ` +
          `${m.advance.toFixed(1).padStart(6)} ${fit.toFixed(2).padStart(9)} ${String(blk.font_size).padStart(6)}`
        );
      }
    }
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("measure_ink.js")) {
  process.exit(main());
}
