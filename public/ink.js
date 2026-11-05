// ═══════════════════════════════════════════════════════════════
// Ink metrics — measure the artwork's real lettering geometry.
//
// mokuro's `font_size` is NOT the glyph size. From
// comic_text_detector/utils/textblock.py::examine_textblk():
//
//     vertical   -> font_size = norm_h / len(lines)   (the line's WIDTH)
//     horizontal -> font_size = norm_v / len(lines)   (the line's HEIGHT)
//
// So for a single-line block it is the QUAD's cross-axis size — and the
// quad also contains the speech bubble's edges and the page around the
// lettering. Fitting the overlay to the quad makes the text ~40% too
// big. That is the "stretched" look.
//
// This module measures the INK inside each detected quad so the overlay
// can be fitted to the lettering itself.
//
// The measurement is polarity-agnostic: it compares each row (or
// column) against its own median, so it works on a white speech bubble
// on a black page and on black text on white. Guessing the polarity
// from the histogram does not work — the crop's modal brightness is
// often the PAGE, not the bubble, and the "ink" then comes out as the
// bubble.
//
// The measurement runs in the browser on the very pixels the reader is
// showing, so it needs no extra decoding on the server.
// ═══════════════════════════════════════════════════════════════

/**
 * The browser's CJK metrics, measured in the reader's own font stack by
 * rasterising a glyph and measuring its ink:
 *
 *   advance per character   0.9521 em
 *   ink height              0.8500 em
 *   ink width               0.8500 em
 */
const BROWSER = {
  advance: 0.9521,
  inkHeight: 0.85,
  inkWidth: 0.85,
};

/**
 * Measure the font's own metrics by rasterising it.
 *
 * Hardcoding the ratios works until the font stack changes, or the
 * browser substitutes a different font for CJK. Measuring is cheap
 * (one small canvas) and makes the calibration self-maintaining.
 *
 * Returns { advance, inkHeight, inkWidth } in em.
 */
function measureFontMetrics(fontStack) {
  const stack = fontStack || getComputedStyle(document.body).fontFamily;
  const sample = "因为这里离你家很远我想回家";

  // The advance per character.
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 8;
  const ctx = c.getContext("2d");
  ctx.font = "100px " + stack;
  const advance = ctx.measureText(sample).width / sample.length / 100;

  // The ink of a single glyph, at a big size so the pixel grid does
  // not distort the measurement.
  const size = 100;
  const pad = 20;
  const gc = document.createElement("canvas");
  gc.width = size + pad * 2;
  gc.height = size + pad * 2;
  const gx = gc.getContext("2d");
  gx.fillStyle = "#fff";
  gx.fillRect(0, 0, gc.width, gc.height);
  gx.fillStyle = "#000";
  gx.font = size + "px " + stack;
  gx.textBaseline = "alphabetic";
  gx.fillText(sample[0], pad, pad + 80);

  const d = gx.getImageData(0, 0, gc.width, gc.height).data;
  let x0 = -1, x1 = -1, y0 = -1, y1 = -1;
  for (let y = 0; y < gc.height; y++) {
    for (let x = 0; x < gc.width; x++) {
      if (d[(y * gc.width + x) * 4] < 128) {
        if (x0 < 0 || x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y0 < 0 || y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x0 < 0) return { advance, inkHeight: BROWSER.inkHeight, inkWidth: BROWSER.inkWidth };

  return {
    advance,
    inkHeight: (y1 - y0 + 1) / size,
    inkWidth: (x1 - x0 + 1) / size,
    // Where the ink sits inside the em box, in em. The overlay's
    // characters are positioned by their em box, so the em box has to
    // be moved by these to put the INK on the artwork's lettering.
    //
    // In vertical writing the roles swap: the glyph's TOP side bearing
    // becomes the RIGHT one, and the LEFT bearing is the one that
    // shows on the cross axis. Both are recorded.
    inkOffsetX: x0 / size,
    inkOffsetY: y0 / size,
    inkOffsetXRight: (size - x1) / size,
    inkOffsetYBottom: (size - y1) / size,
  };
}

/** A small scratch canvas for reading pixels out of the page image. */
let scratch = null;

function getScratch() {
  if (!scratch) {
    scratch = document.createElement("canvas");
    scratch.width = 1;
    scratch.height = 1;
  }
  return scratch;
}

/**
 * Read a region of an <img> into a greyscale byte array.
 *
 * The image is drawn at its natural size, so the coordinates are in
 * image pixels. Returns { data, width, height }.
 *
 * The scratch canvas is resized for every region, which RESETS its
 * context state — so the context has to be re-fetched and the options
 * re-applied every time.
 */
function readRegion(img, x0, y0, w, h) {
  const c = getScratch();
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext("2d", { willReadFrequently: true });
  // The region may sit outside the image if the quad does; clip it.
  const sx = Math.max(0, x0);
  const sy = Math.max(0, y0);
  const sw = Math.min(img.naturalWidth, x0 + w) - sx;
  const sh = Math.min(img.naturalHeight, y0 + h) - sy;
  if (sw <= 0 || sh <= 0) return null;

  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, sx, sy, sw, sh, sx - x0, sy - y0, sw, sh);

  const rgba = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    gray[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  return { data: gray, width: w, height: h };
}

/**
 * The median of a byte array.
 *
 * A 256-bucket histogram, not a sort: this runs once per row (or
 * column) of every measured line, so it is on the hot path.
 */
const MEDIAN_HIST = new Uint32Array(256);
function median(values, len) {
  if (!len) return 0;
  MEDIAN_HIST.fill(0);
  for (let i = 0; i < len; i++) MEDIAN_HIST[values[i]]++;
  let total = 0;
  for (let v = 0; v < 256; v++) {
    total += MEDIAN_HIST[v];
    if (total * 2 >= len) return v;
  }
  return 0;
}

/**
 * Measure the ink inside a quad.
 *
 * `quad` is [[x,y], ...] in image pixels; `vertical` says which way the
 * text runs. Returns null when there is no ink to measure.
 */
function measureInk(img, quad, vertical) {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(img.naturalWidth, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(img.naturalHeight, Math.ceil(Math.max(...ys)));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 4 || h < 4) return null;

  let region;
  try {
    region = readRegion(img, x0, y0, w, h);
  } catch {
    // A tainted canvas (cross-origin image) — cannot measure.
    return null;
  }
  if (!region) return null;
  const { data } = region;

  // ── The cross-axis profile: rows for horizontal text, columns for
  // vertical. Each slice is compared against its OWN median, so a row
  // of glyph strokes stands out and a blank row of bubble does not.
  const crossLen = vertical ? w : h;
  const alongLen = vertical ? h : w;
  const crossProfile = new Float64Array(crossLen);
  const alongProfile = new Float64Array(alongLen);

  const slice = new Uint8Array(alongLen);
  for (let c = 0; c < crossLen; c++) {
    for (let a = 0; a < alongLen; a++) {
      // The cross axis is rows for horizontal text and columns for
      // vertical text. data is row-major: data[row * w + col].
      //
      //   horizontal — c is a ROW, a is a column: data[c * w + a]
      //   vertical   — c is a COLUMN, a is a row: data[a * w + c]
      slice[a] = vertical ? data[a * w + c] : data[c * w + a];
    }
    const med = median(slice, alongLen);
    let dev = 0;
    for (let a = 0; a < alongLen; a++) dev += Math.abs(slice[a] - med);
    crossProfile[c] = dev / alongLen;
  }

  {
    const col = new Uint8Array(crossLen);
    for (let a = 0; a < alongLen; a++) {
      for (let c = 0; c < crossLen; c++) {
        col[c] = vertical ? data[a * w + c] : data[c * w + a];
      }
      const med = median(col, crossLen);
      let dev = 0;
      for (let c = 0; c < crossLen; c++) dev += Math.abs(col[c] - med);
      alongProfile[a] = dev / crossLen;
    }
  }

  let maxCross = 0, maxAlong = 0;
  for (let i = 0; i < crossLen; i++) if (crossProfile[i] > maxCross) maxCross = crossProfile[i];
  for (let i = 0; i < alongLen; i++) if (alongProfile[i] > maxAlong) maxAlong = alongProfile[i];
  if (maxCross <= 0 || maxAlong <= 0) return null;

  // The text's extent along the cross axis — this is the GLYPH HEIGHT.
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
    if (gap <= Math.max(2, crossExtent * 0.12)) merged[merged.length - 1][1] = runs[i][1];
    else merged.push(runs[i]);
  }

  const gaps = [];
  for (let i = 1; i < merged.length; i++) gaps.push(merged[i][0] - merged[i - 1][1] - 1);
  gaps.sort((a, b) => a - b);
  const medGap = gaps.length ? gaps[gaps.length >> 1] : 0;

  const alongExtent = merged[merged.length - 1][1] - merged[0][0] + 1;
  const count = merged.length;

  return {
    /** The ink's extent across the text — the glyph height. */
    crossExtent,
    /** The ink's extent along the text. */
    alongExtent,
    /** How many characters the segmentation found. */
    count,
    /** The typical gap between characters. */
    gap: medGap,
    /** The advance per character. */
    advance: count ? (alongExtent + medGap) / count : 0,
    /** Where the ink starts, relative to the quad. */
    offset: vertical
      ? { x: cLo, y: merged[0][0] }
      : { x: merged[0][0], y: cLo },
  };
}

/* Exposed on window so the plain-script app can use it — the reader is
   loaded with a classic <script>, not as a module. */
window.MANGA_INK = { measureInk, measureFontMetrics, BROWSER };
