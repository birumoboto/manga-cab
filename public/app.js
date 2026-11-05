// ═══════════════════════════════════════════════════════════════
// MANGA.CAB — webtoon reader client
//
// Infinite vertical scroll over a list of page images, with an
// optional OCR text layer that makes the pages selectable.
// ═══════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

// The app may be mounted under a path prefix (e.g. "/manga" when several
// apps share one Tailscale Serve hostname). Resolve every API and asset
// URL against that prefix so relative deployment works unchanged.
const BASE = (() => {
  // A <base href> wins if the server set one.
  const baseEl = document.querySelector("base[href]");
  if (baseEl) {
    const href = baseEl.getAttribute("href") || "";
    return href.endsWith("/") ? href.slice(0, -1) : href;
  }
  const path = window.location.pathname;
  // If we are inside /manga/... but not at the app root, keep the prefix.
  const m = path.match(/^(.*\/manga)(?:\/|$)/);
  return m ? m[1] : "";
})();

/** Build an absolute app URL from a path like "/api/volumes". */
const url = (p) => `${BASE}${p}`;

const els = {
  app: $("app"),
  reader: $("reader"),
  readerScreen: $("readerScreen"),
  pages: $("pages"),
  empty: $("empty"),
  emptyUpload: $("emptyUpload"),
  title: $("volumeTitle"),
  meta: $("volumeMeta"),
  library: $("library"),
  libraryUploadBtn: $("libraryUploadBtn"),
  backBtn: $("backBtn"),
  volumeList: $("volumeList"),
  dropZone: $("dropZone"),
  fileInput: $("fileInput"),
  folderInput: $("folderInput"),
  pickFiles: $("pickFiles"),
  pickFolder: $("pickFolder"),
  titleInput: $("titleInput"),
  uploadStatus: $("uploadStatus"),
  ocrToggle: $("ocrToggle"),
  textToggle: $("textToggle"),
  textPanelBtn: $("textPanelBtn"),
  transcript: $("transcript"),
  transcriptClose: $("transcriptClose"),
  transcriptBody: $("transcriptBody"),
  ocrSheet: $("ocrSheet"),
  ocrSheetHandle: $("ocrSheetHandle"),
  ocrSheetLabel: $("ocrSheetLabel"),
  modeHint: $("modeHint"),
  fsBtn: $("fsBtn"),
  mokuroInput: $("mokuroInput"),
  pickMokuro: $("pickMokuro"),
  runOcr: $("runOcr"),
  langSelect: $("langSelect"),
  ocrProgress: $("ocrProgress"),
  rail: $("rail"),
  railFill: $("railFill"),
  indicator: $("pageIndicator"),
};

const state = {
  volume: null,
  // "off"  — no overlay at all
  // "tap"  — transparent overlay; characters are hit-tested by tap
  // "read" — text is drawn visibly so it can be selected and read
  ocrMode: "tap",
  ocr: false,
  ocrData: null,
  visible: new Set(),
  observer: null,
  chars: [],            // character spans in the OCR overlay, for hit-testing
  transcriptChars: [],  // character spans in the transcript panel
  tapTimer: null,
  tapPoint: null,
};

// Correction factor applied to mokuro's font_size.
//
// mokuro reports the ink height of the tallest glyph. A CJK glyph is drawn
// inside an em box that is taller than its ink, so rendering at exactly
// font_size makes the overlay text look noticeably larger than the
// artwork. This factor trims it to match. 1.0 = no correction.
//
// Tuned against real Chinese webtoon pages: the overlay line box measured
// ~1.29x the artwork's line height at 1.0, so ~0.78 lands them together.
const OCR_FONT_FACTOR = 0.78;

// ═══════════════════════════════════════════════════════════════
// Navigation — the shelf and the reader are two full screens.
//
// The shelf is the "main menu". The reader has a permanent, unmissable
// BACK button in its own header, so getting back is always one tap and
// never depends on finding a hidden menu.
// ═══════════════════════════════════════════════════════════════

function showShelf() {
  els.app.classList.remove("view-reader");
  els.app.classList.add("view-library");
  closeSheet();
  toggleTranscript(false);
  // The progress rail and page indicator belong to the reader. Hide them
  // so they do not float over the shelf.
  els.rail.hidden = true;
  els.indicator.hidden = true;
  loadVolumes();
}

function showReader() {
  els.app.classList.remove("view-library");
  els.app.classList.add("view-reader");
}

els.backBtn.addEventListener("click", showShelf);
els.emptyUpload.addEventListener("click", showShelf);
els.libraryUploadBtn.addEventListener("click", () => els.pickFolder.click());

// The Android / iOS back gesture should also return to the shelf.
window.addEventListener("popstate", () => {
  if (els.app.classList.contains("view-reader")) showShelf();
});
history.pushState({ view: "shelf" }, "", location.href);

// ═══════════════════════════════════════════════════════════════
// Volume list
// ═══════════════════════════════════════════════════════════════

async function loadVolumes() {
  try {
    const res = await fetch(url("/api/volumes"));
    const { volumes } = await res.json();
    renderVolumes(volumes || []);
  } catch (e) {
    els.uploadStatus.textContent = "Could not load library: " + e.message;
    els.uploadStatus.className = "upload-status error";
  }
}

function renderVolumes(volumes) {
  els.volumeList.innerHTML = "";
  if (!volumes.length) {
    const li = document.createElement("li");
    li.style.cursor = "default";
    li.style.borderStyle = "dashed";
    li.innerHTML = `<div class="vl-info"><div class="vl-sub">No volumes yet — upload one above.</div></div>`;
    els.volumeList.appendChild(li);
    return;
  }

  for (const v of volumes) {
    const li = document.createElement("li");
    if (state.volume && state.volume.id === v.id) li.classList.add("active");

    const thumb = document.createElement("img");
    thumb.className = "vl-thumb";
    thumb.alt = "";
    thumb.loading = "lazy";
    if (v.pageCount > 0) thumb.src = url(`/v/${v.id}/pages/${v.pages[0].file}`);

    const info = document.createElement("div");
    info.className = "vl-info";
    const date = new Date(v.createdAt || 0).toLocaleDateString();
    info.innerHTML = `<div class="vl-title"></div><div class="vl-sub">${v.pageCount} pages · ${date}</div>`;
    info.querySelector(".vl-title").textContent = v.title;

    const del = document.createElement("button");
    del.className = "vl-del";
    del.textContent = "×";
    del.title = "Delete volume";
    del.setAttribute("aria-label", `Delete ${v.title}`);
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${v.title}"?`)) return;
      await fetch(url(`/api/volumes/${v.id}`), { method: "DELETE" });
      if (state.volume?.id === v.id) closeVolume();
      loadVolumes();
    });

    li.append(thumb, info, del);
    li.addEventListener("click", () => openVolume(v.id));
    els.volumeList.appendChild(li);
  }
}

// ═══════════════════════════════════════════════════════════════
// Reading a volume
// ═══════════════════════════════════════════════════════════════

async function openVolume(id) {
  const res = await fetch(url(`/api/volumes/${id}`));
  if (!res.ok) return;
  const meta = await res.json();
  state.volume = meta;

  els.title.textContent = meta.title;
  els.meta.textContent = `${meta.pageCount} pages`;
  els.empty.classList.add("hidden");
  els.rail.hidden = false;
  els.indicator.hidden = false;

  renderPages(meta);
  loadOcr(id);

  els.reader.scrollTop = 0;
  showReader();
  renderVolumes(await (await fetch(url("/api/volumes"))).json().then((d) => d.volumes || []));
}

function closeVolume() {
  state.volume = null;
  state.ocrData = null;
  els.pages.innerHTML = "";
  els.empty.classList.remove("hidden");
  els.rail.hidden = true;
  els.indicator.hidden = true;
  els.title.textContent = "MANGA.CAB";
  els.meta.textContent = "webtoon reader";
  setOcr(false);
}

function renderPages(meta) {
  els.pages.innerHTML = "";

  if (state.observer) state.observer.disconnect();

  for (const page of meta.pages) {
    const wrap = document.createElement("div");
    wrap.className = "page";
    wrap.dataset.index = page.index;
    wrap.dataset.file = page.file;

    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = `Page ${page.index + 1}`;
    img.src = url(`/v/${meta.id}/pages/${page.file}`);

    const layer = document.createElement("div");
    layer.className = "ocr-layer";

    wrap.append(img, layer);
    els.pages.appendChild(wrap);
  }

  // Track which page is in view, for the indicator + lazy OCR rendering.
  state.observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const idx = Number(e.target.dataset.index);
        if (e.isIntersecting) {
          state.visible.add(idx);
          e.target.classList.add("in-view");
        } else {
          state.visible.delete(idx);
        }
      }
      updateIndicator();
    },
    { root: els.reader, threshold: [0, 0.25, 0.6] }
  );

  for (const p of els.pages.children) state.observer.observe(p);

  els.reader.addEventListener("scroll", onScroll, { passive: true });
  updateIndicator();
}

function onScroll() {
  const max = els.reader.scrollHeight - els.reader.clientHeight;
  const pct = max > 0 ? (els.reader.scrollTop / max) * 100 : 0;
  els.railFill.style.width = pct + "%";
}

function updateIndicator() {
  if (!state.volume) return;
  const inView = [...state.visible].sort((a, b) => a - b);
  if (!inView.length) {
    els.indicator.textContent = `1 / ${state.volume.pageCount}`;
    return;
  }
  // The page occupying the most of the viewport is the one you are "on".
  const top = els.reader.getBoundingClientRect().top;
  let best = inView[0];
  let bestDist = Infinity;
  for (const idx of inView) {
    const el = els.pages.children[idx];
    if (!el) continue;
    const d = Math.abs(el.getBoundingClientRect().top - top);
    if (d < bestDist) { bestDist = d; best = idx; }
  }
  els.indicator.textContent = `${best + 1} / ${state.volume.pageCount}`;
}

// ═══════════════════════════════════════════════════════════════
// OCR text layer
// ═══════════════════════════════════════════════════════════════

async function loadOcr(id) {
  state.ocrData = null;
  try {
    const res = await fetch(url(`/v/${id}/mokuro`));
    if (!res.ok) return;
    const data = await res.json();
    state.ocrData = data && data.pages ? data : null;
    if (state.ocr) applyOcr();
    // Refresh the transcript if it is open, so it shows the new data.
    if (!els.transcript.hidden) renderTranscript();
  } catch {
    // No OCR data for this volume — fine.
  }
}

/**
 * Attach a .mokuro OCR file to a volume and refresh the overlay.
 */
async function attachMokuro(volumeId, file) {
  const fd = new FormData();
  fd.append("mokuro", file, file.name || "volume.mokuro");
  const res = await fetch(url(`/api/volumes/${volumeId}/mokuro`), { method: "POST", body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "failed to attach OCR data");
  await loadOcr(volumeId);
  if (state.ocr) applyOcr();
  return data;
}

function setOcr(on) {
  state.ocr = on;
  els.ocrToggle.setAttribute("aria-pressed", on ? "true" : "false");
  if (on) applyOcr();
  else clearOcr();
}

// ── OCR display modes ───────────────────────────────────────────
//
// "off"  — no overlay. Pure artwork.
// "tap"  — the overlay exists but is transparent. Tapping a character
//          highlights it. Scrolling over the artwork always works,
//          because the layer is pointer-events: none.
// "read" — the text is drawn visibly on a readable background, so you
//          can select it, copy it, or have an add-on read it back.
//
// The mode is a separate axis from the on/off toggle: the toggle still
// controls whether the overlay exists at all.

const OCR_MODES = {
  off: {
    label: "OFF",
    hint: "No text layer. The artwork is clean.",
  },
  tap: {
    label: "TAP",
    hint: "The text is invisible but tappable — tap a bubble to read it. Scrolling always works.",
  },
  read: {
    label: "READ",
    hint: "The text is drawn on the page, so you can select it with your finger, copy it, or use a reading add-on.",
  },
};

function setOcrMode(mode) {
  if (!OCR_MODES[mode]) return;
  state.ocrMode = mode;

  for (const btn of document.querySelectorAll(".mode-btn")) {
    const on = btn.dataset.mode === mode;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  }
  els.modeHint.textContent = OCR_MODES[mode].hint;

  // "off" turns the layer off entirely; the others keep it on.
  setOcr(mode !== "off");

  // Reflect the state on the top-bar toggle too.
  els.ocrToggle.setAttribute("aria-pressed", mode === "off" ? "false" : "true");
}

for (const btn of document.querySelectorAll(".mode-btn")) {
  btn.addEventListener("click", () => setOcrMode(btn.dataset.mode));
}

// ── The bottom sheet ────────────────────────────────────────────

function openSheet() {
  els.ocrSheet.hidden = false;
  requestAnimationFrame(() => els.ocrSheet.classList.add("open"));
  els.ocrSheetHandle.setAttribute("aria-expanded", "true");
  els.ocrSheetLabel.textContent = "CLOSE";
}

function closeSheet() {
  els.ocrSheet.classList.remove("open");
  els.ocrSheetHandle.setAttribute("aria-expanded", "false");
  els.ocrSheetLabel.textContent = "OCR TEXT";
  setTimeout(() => { els.ocrSheet.hidden = true; }, 250);
}

function toggleSheet() {
  if (els.ocrSheet.classList.contains("open")) closeSheet();
  else openSheet();
}

els.ocrSheetHandle.addEventListener("click", toggleSheet);

function clearOcr() {
  state.chars = [];
  for (const page of els.pages.children) {
    page.classList.remove("ocr-active");
    const layer = page.querySelector(".ocr-layer");
    if (layer) {
      layer.classList.remove("on");
      layer.innerHTML = "";
    }
  }
}

function applyOcr() {
  if (!state.ocr || !state.ocrData) return;
  const pages = state.ocrData.pages || [];

  // The .mokuro page order matches the uploaded order when the volume was
  // produced by mokuro itself. If the lengths differ, match by image name.
  const byName = new Map();
  for (const p of pages) if (p.img_path) byName.set(baseName(p.img_path), p);

  for (const wrap of els.pages.children) {
    wrap.classList.add("ocr-active");
    const layer = wrap.querySelector(".ocr-layer");
    if (!layer) continue;
    layer.classList.add("on");
    // The display mode changes how the text is painted and whether the
    // layer takes pointer events.
    layer.classList.toggle("mode-read", state.ocrMode === "read");
    layer.classList.toggle("mode-tap", state.ocrMode === "tap");
    layer.innerHTML = "";

    const page = byName.get(wrap.dataset.file) || pages[Number(wrap.dataset.index)];
    if (!page || !page.blocks) continue;

    const img = wrap.querySelector("img");
    const W = page.img_width || img.naturalWidth || 1;
    const H = page.img_height || img.naturalHeight || 1;
    const pageIndex = Number(wrap.dataset.index);

    for (let blockIndex = 0; blockIndex < page.blocks.length; blockIndex++) {
      const block = page.blocks[blockIndex];
      const [x0, y0, x1, y1] = block.box || [];
      if ([x0, y0, x1, y1].some((v) => typeof v !== "number")) continue;

      const box = document.createElement("div");
      box.className = "ocr-box";
      // Percentages so the overlay survives any CSS scaling.
      box.style.left = (x0 / W) * 100 + "%";
      box.style.top = (y0 / H) * 100 + "%";
      box.style.width = ((x1 - x0) / W) * 100 + "%";
      // The height is only a hint for positioning — the text is allowed to
      // overflow it (see .ocr-box in styles.css), because the detected box
      // is the *ink* bounding box, which is often shorter than the text
      // needs once punctuation and descenders are laid out.
      box.style.height = ((y1 - y0) / H) * 100 + "%";

      // Font size must scale with the image, not be a fixed pixel value.
      //
      // The block's box is given in *image* pixels, and mokuro's font_size
      // is the height of the text in those same image pixels. The image is
      // rendered at some display width, so to make the overlay text the
      // same size as the artwork we need:
      //
      //     display px = font_size * (rendered image width / image width)
      //
      // The overlay layer is a CSS container (`container-type: inline-size`)
      // that is exactly as wide as the rendered image, so `cqw` equals the
      // image's display width. That makes the font size track the artwork
      // at any screen size and any max-width cap, with no magic numbers:
      //
      //     font-size = (font_size / image_width) * 100cqw
      //
      // mokuro's font_size is the ink height of the tallest glyph. A CJK
      // glyph is drawn inside an em box that is taller than its ink, so we
      // apply a correction factor to land on the artwork's apparent size
      // rather than overshooting it. OCR_FONT_FACTOR tunes this.
      const ratio = ((block.font_size || 16) * OCR_FONT_FACTOR) / W;
      box.style.setProperty("--ocr-size", (ratio * 100).toFixed(4) + "cqw");

      if (block.vertical) {
        box.style.writingMode = "vertical-rl";
        box.style.textAlign = "start";
        box.classList.add("vertical");
      }

      // Each detected line gets its own line element, positioned at the
      // exact quadrilateral mokuro detected for it (lines_coords). That
      // puts every OCR section on its own line, exactly where it sits in
      // the artwork — instead of stacking the lines by guesswork.
      const lines = block.lines || [];
      const coords = block.lines_coords || [];
      const bx0 = x0, by0 = y0, bx1 = x1, by1 = y1;
      const bw = bx1 - bx0, bh = by1 - by0;

      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        const line = document.createElement("div");
        line.className = "ocr-line";

        // Position from the detected line quad, relative to the block box.
        const quad = coords[i];
        let quadW = 0, quadH = 0;
        if (quad && bw > 0 && bh > 0) {
          const xs = quad.map((p) => p[0]);
          const ys = quad.map((p) => p[1]);
          const lx0 = Math.min(...xs), lx1 = Math.max(...xs);
          const ly0 = Math.min(...ys), ly1 = Math.max(...ys);
          quadW = lx1 - lx0;
          quadH = ly1 - ly0;
          line.style.left = ((lx0 - bx0) / bw) * 100 + "%";
          line.style.top = ((ly0 - by0) / bh) * 100 + "%";
          line.style.width = (quadW / bw) * 100 + "%";
          line.style.height = (quadH / bh) * 100 + "%";
          line.classList.add("placed");
        }

        // Index of this line inside its block, and the page it is on.
        line.dataset.ocrLine = String(i);
        line.dataset.ocrPage = String(pageIndex);

        const spans = buildCharSpans(lineText);
        line.append(...spans);
        for (const s of spans) {
          if (s.classList?.contains("ocr-char")) {
            s.dataset.ocrPage = String(pageIndex);
            s.dataset.ocrLine = String(i);
            s.dataset.ocrBlock = String(blockIndex);
            state.chars.push(s);
          }
        }

        // ── Fit the text to its quad ────────────────────────────
        //
        // The artwork's CJK lettering is CONDENSED: the real ink is
        // 0.58-0.83 as wide as it is tall, while a browser lays out
        // square CJK glyphs. So the natural width of the text is far
        // wider than the detected quad, and the text spills out of it,
        // overlaps its neighbours, and bleeds past the white panel.
        //
        // The fix is to fit the text to the quad it was detected in:
        //
        //   horizontal line — the glyph height is the quad's HEIGHT,
        //                    and the advance width is condensed to fit
        //   vertical line   — the glyph height is the quad's WIDTH,
        //                    and the advance down the column is
        //                    condensed to fit
        //
        // Both factors are per line, because each line has its own quad.
        // The size is expressed in cqw (the layer's width, which is the
        // image's display width), so it tracks the artwork at any size.
        //
        // The CONDENSE is a transform, so it does not change the line's
        // layout box — the line keeps the quad's width, and the glyphs
        // inside it are squeezed to fit. That is what we want: the box
        // stays where the artwork is, and only the text is condensed.
        const nChars = Math.max(1, spans.length);
        const vertical = !!block.vertical;
        if (quadW > 0 && quadH > 0) {
          const fs = block.font_size || 16;

          // The cross-axis extent of the glyphs: the line's height when
          // the text runs horizontally, its width when it runs
          // vertically.
          const glyphBox = vertical ? quadW : quadH;

          // The along-axis extent the text has to fit into.
          const alongBox = vertical ? quadH : quadW;

          // The font size whose EM BOX matches the cross-axis extent.
          // The em box is what getBoundingClientRect() reports for a
          // text run, so matching it to the quad is what keeps the
          // glyphs inside the quad — and the quad is the artwork's own
          // ink box, so this lines the overlay up with the lettering.
          const fitSize = glyphBox;

          // The size mokuro reported is the ink height. For a vertical
          // line that is the glyph's width across the column, so it
          // already matches the cross axis — but a vertical line is
          // often TALLER than one character, so the font can be larger
          // than mokuro's estimate. Allow it to grow to fill the quad.
          const sizeScale = vertical
            ? Math.max(1, fitSize / fs)
            : Math.min(1, fitSize / fs);

          // Condense along the text's own axis so the text fits.
          // The natural advance is one em per CJK character.
          const naturalAdvance = fs * sizeScale;
          const targetAdvance = alongBox / nChars;
          const condense = Math.min(1, targetAdvance / naturalAdvance);

          // The size is a fraction of the layer's width (cqw), so the
          // line scales with the artwork at any screen size.
          const baseSize = (fs / W) * 100;          // percent of the layer
          line.style.setProperty("--ocr-line-size",
            (baseSize * sizeScale).toFixed(4) + "cqw");
          line.style.setProperty("--ocr-condense", condense.toFixed(4));

          // The line's layout box must be the quad's size so the
          // characters are laid out inside it. The transform then
          // condenses them visually.
          //
          // The transform scales the box along the text's own axis, so
          // that axis is divided by the condense factor — after the
          // transform the box renders at exactly the quad's size. The
          // CROSS axis is not scaled, so it is set to the quad directly.
          if (vertical) {
            line.style.width = (quadW / bw) * 100 + "%";
            line.style.height = (quadH / condense / bh) * 100 + "%";
          } else {
            line.style.width = (quadW / condense / bw) * 100 + "%";
            line.style.height = (quadH / bh) * 100 + "%";
          }
        }

        box.appendChild(line);
      }
      box.dataset.ocrBlock = String(blockIndex);
      box.dataset.ocrPage = String(pageIndex);
      // A block with no text at all (OCR detected a region but read
      // nothing) has no zone worth revealing, so it is not rendered.
      if (!box.textContent.trim()) {
        box.remove();
        continue;
      }
      layer.appendChild(box);
    }
  }
}

/**
 * Build character-level spans.
 *
 * Every character is its own span, so a tap can select exactly one
 * character. Chinese text has no spaces, so word-level spans would be
 * useless there — character granularity is what the user asked for and
 * it works for both scripts.
 */
function buildCharSpans(text) {
  const spans = [];
  for (const ch of text) {
    if (ch === "\n") continue;
    const span = document.createElement("span");
    span.className = "ocr-char";
    span.textContent = ch;
    spans.push(span);
  }
  return spans;
}

/**
 * Find the character under a viewport point.
 *
 * The OCR layer keeps `pointer-events: none` so that dragging over the text
 * still scrolls the reader — that is essential in a webtoon reader. So we
 * cannot rely on DOM event targets; we hit-test the character rects ourselves.
 */
function charAtPoint(x, y) {
  for (const ch of state.chars) {
    const r = ch.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // Cheap vertical reject before the full bounds test.
    if (y < r.top - 2 || y > r.bottom + 2) continue;
    if (x >= r.left && x <= r.right) return ch;
  }
  return null;
}

/**
 * The clickable ZONE for a detected text block.
 *
 * The zone is the area of the artwork where the text lives. mokuro gives
 * us a bounding box per block (the ink area) and a quadrilateral per line.
 * The union of the line quads is the real extent of the rendered text —
 * the block box can be tighter than the text, and the text can overflow
 * it, so the line rects are the honest answer.
 *
 * A little padding is added so the zone is a comfortable tap target even
 * when the text is small.
 */
const ZONE_PAD_X = 10;
const ZONE_PAD_Y = 6;

function zoneRect(boxEl) {
  // The zone is the extent of the TEXT, so measure the characters
  // themselves. A line box is sized from the detected quad, but its text
  // can overflow that (the ink box is often narrower than the laid-out
  // text), so the characters are the honest answer.
  const chars = boxEl.querySelectorAll(".ocr-char");
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;

  for (const ch of chars) {
    const r = ch.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }

  // No characters rendered (lazy rendering) — fall back to the line boxes.
  if (!Number.isFinite(left)) {
    for (const line of boxEl.querySelectorAll(".ocr-line")) {
      const r = line.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
  }

  // Still nothing — fall back to the block box itself.
  if (!Number.isFinite(left)) {
    const r = boxEl.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    left = r.left; top = r.top; right = r.right; bottom = r.bottom;
  }

  return {
    left: left - ZONE_PAD_X,
    top: top - ZONE_PAD_Y,
    right: right + ZONE_PAD_X,
    bottom: bottom + ZONE_PAD_Y,
    width: (right - left) + ZONE_PAD_X * 2,
    height: (bottom - top) + ZONE_PAD_Y * 2,
  };
}

/**
 * Find the text zone under a viewport point.
 *
 * Zones are checked in reverse document order so the one drawn last (the
 * topmost) wins when zones overlap.
 */
function zoneAtPoint(x, y) {
  const boxes = document.querySelectorAll(".ocr-box");
  for (let i = boxes.length - 1; i >= 0; i--) {
    const box = boxes[i];
    const r = zoneRect(box);
    if (!r) continue;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return { box, rect: r };
    }
  }
  return null;
}

/**
 * Reveal a text zone: draw the block's characters on a white panel.
 *
 * Only one zone is revealed at a time — revealing every zone at once
 * would cover the artwork in white boxes.
 */
function revealZone(boxEl) {
  for (const b of document.querySelectorAll(".ocr-box.revealed")) {
    b.classList.remove("revealed");
  }
  if (!boxEl) return null;
  boxEl.classList.add("revealed");
  return boxEl;
}

/** Hide any revealed zone. */
function collapseZones() {
  for (const b of document.querySelectorAll(".ocr-box.revealed")) {
    b.classList.remove("revealed");
  }
}

/**
 * Handle a tap on the OCR layer.
 *
 * A tap inside a text zone reveals that zone — the characters are drawn on
 * a white panel so they can be read. A tap on a character also highlights
 * that character.
 *
 * A tap OUTSIDE any zone clears everything: the revealed zone collapses
 * and the character highlight is removed.
 *
 * It does NOT select the text or copy it: clicking is enough, and the
 * browser's own long-press selection still works if you want a run of
 * text.
 */
function handleCharTap(x, y) {
  // Work out what was tapped BEFORE revealing anything — revealing
  // changes the layout (the white panel pads the text).
  const ch = charAtPoint(x, y);
  const zone = zoneAtPoint(x, y);

  if (!zone) {
    // Clicked off the text: clear the highlight and collapse the zone.
    clearTappedChars();
    collapseZones();
    return false;
  }

  // Reveal the zone the user hit.
  revealZone(zone.box);

  if (ch) {
    clearTappedChars();
    ch.classList.add("tapped");
  }
  return true;
}

/** Remove the highlight from every tapped character. */
function clearTappedChars() {
  for (const c of document.querySelectorAll(".ocr-char.tapped")) {
    c.classList.remove("tapped");
  }
}

function baseName(p) {
  const parts = String(p).replace(/\\/g, "/").split("/");
  return parts[parts.length - 1];
}

// The top-bar OCR button cycles the display modes: off → tap → read.
els.ocrToggle.addEventListener("click", () => {
  const order = ["off", "tap", "read"];
  const next = order[(order.indexOf(state.ocrMode) + 1) % order.length];
  setOcrMode(next);
});

// ═══════════════════════════════════════════════════════════════
// Uploads
// ═══════════════════════════════════════════════════════════════

els.dropZone.addEventListener("click", () => els.pickFiles.click());
els.dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.pickFiles.click(); }
});
els.pickFiles.addEventListener("click", () => els.fileInput.click());
els.pickFolder.addEventListener("click", () => els.folderInput.click());

els.fileInput.addEventListener("change", (e) => {
  if (e.target.files?.length) handleFiles([...e.target.files]);
  e.target.value = "";
});
els.folderInput.addEventListener("change", (e) => {
  if (e.target.files?.length) handleFiles([...e.target.files]);
  e.target.value = "";
});

// Drag & drop — including folders (webkitGetAsEntry)
["dragenter", "dragover"].forEach((ev) =>
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropZone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((ev) =>
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "dragleave" && els.dropZone.contains(e.relatedTarget)) return;
    els.dropZone.classList.remove("drag");
  })
);
els.dropZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  const items = e.dataTransfer?.items;
  if (!items?.length) return;

  const files = [];
  const entries = [...items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);

  if (entries.length) {
    for (const entry of entries) {
      const collected = await walkEntry(entry);
      files.push(...collected);
    }
  } else {
    files.push(...[...e.dataTransfer.files]);
  }

  if (files.length) handleFiles(files);
});

/** Recursively collect files from a drag-dropped FileSystemEntry. */
async function walkEntry(entry) {
  if (entry.isFile) {
    return await new Promise((resolve) => {
      entry.file((f) => resolve([f]), () => resolve([]));
    });
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const all = [];
    // readEntries returns at most 100 entries per call.
    for (;;) {
      const batch = await new Promise((resolve) => {
        reader.readEntries(resolve, () => resolve([]));
      });
      if (!batch.length) break;
      for (const child of batch) {
        all.push(...(await walkEntry(child)));
      }
    }
    return all;
  }
  return [];
}

async function handleFiles(files) {
  const title = els.titleInput.value.trim();

  // A single .zip/.cbz goes down the archive path.
  const archives = files.filter((f) => /\.(zip|cbz)$/i.test(f.name));
  if (archives.length === 1 && files.length === 1) {
    await uploadArchive(archives[0], title);
    return;
  }

  const images = files.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(f.name));
  if (!images.length) {
    setStatus("No images found in the selection.", "error");
    return;
  }

  await uploadImages(images, title);
}

async function uploadImages(files, title) {
  setStatus(`Uploading ${files.length} file${files.length === 1 ? "" : "s"}…`);
  const fd = new FormData();
  for (const f of files) {
    // Preserve the relative path so the server can infer a folder name.
    fd.append("files", f, f.webkitRelativePath || f.name);
  }
  if (title) fd.append("title", title);

  try {
    const res = await fetch(url("/api/upload"), { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "upload failed");
    setStatus(`Uploaded "${data.volume.title}" — ${data.volume.pageCount} pages.`, "ok");
    els.titleInput.value = "";
    await loadVolumes();
    openVolume(data.volume.id);
  } catch (e) {
    setStatus("Upload failed: " + e.message, "error");
  }
}

async function uploadArchive(file, title) {
  setStatus(`Uploading ${file.name}…`);
  const fd = new FormData();
  fd.append("archive", file, file.name);
  if (title) fd.append("title", title);

  try {
    const res = await fetch(url("/api/upload/zip"), { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "upload failed");
    setStatus(`Uploaded "${data.volume.title}" — ${data.volume.pageCount} pages.`, "ok");
    els.titleInput.value = "";
    await loadVolumes();
    openVolume(data.volume.id);
  } catch (e) {
    setStatus("Upload failed: " + e.message, "error");
  }
}

function setStatus(msg, cls = "") {
  els.uploadStatus.textContent = msg;
  els.uploadStatus.className = "upload-status" + (cls ? " " + cls : "");
}

// ── Attaching a .mokuro OCR file ───────────────────────────────
els.pickMokuro.addEventListener("click", () => els.mokuroInput.click());
els.mokuroInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (!state.volume) {
    setStatus("Open a volume first, then attach the .mokuro file.", "error");
    return;
  }
  try {
    const data = await attachMokuro(state.volume.id, file);
    setStatus(`Attached OCR data — ${data.pages} pages.`, "ok");
  } catch (err) {
    setStatus("Could not attach: " + err.message, "error");
  }
});

// ═══════════════════════════════════════════════════════════════
// Running OCR
// ═══════════════════════════════════════════════════════════════

els.runOcr.addEventListener("click", runOcr);

/**
 * Start OCR for the open volume and poll until it finishes.
 */
async function runOcr() {
  if (!state.volume) {
    setOcrStatus("Open a volume first.", "error");
    return;
  }

  const lang = els.langSelect.value;
  els.runOcr.disabled = true;
  setOcrStatus("Starting OCR…");

  let res;
  try {
    res = await fetch(url(`/api/volumes/${state.volume.id}/ocr`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang }),
    });
  } catch (err) {
    els.runOcr.disabled = false;
    setOcrStatus("Could not reach the server: " + err.message, "error");
    return;
  }

  const data = await res.json().catch(() => ({}));

  if (res.status === 409) {
    // Already running — fall through to polling.
  } else if (!res.ok) {
    els.runOcr.disabled = false;
    setOcrStatus(data.error || "OCR failed to start.", "error");
    return;
  }

  pollOcr(state.volume.id);
}

async function pollOcr(volumeId) {
  const started = Date.now();
  // mokuro caches per-page OCR results, so a re-run is much faster.
  const TIMEOUT = 45 * 60 * 1000;

  while (Date.now() - started < TIMEOUT) {
    let status;
    try {
      status = await (await fetch(url("/api/ocr/status"))).json();
    } catch {
      await sleep(1500);
      continue;
    }

    const job = status.jobs?.[volumeId];
    if (job) {
      if (job.status === "running") {
        const secs = Math.round((Date.now() - job.startedAt) / 1000);
        setOcrStatus(`OCR running… ${secs}s elapsed (${job.pages} pages)`);
      } else if (job.status === "done") {
        els.runOcr.disabled = false;
        setOcrStatus(`OCR done — ${job.blocks ?? 0} text blocks found.`, "ok");
        await loadOcr(volumeId);
        if (!state.ocr) setOcr(true);
        else applyOcr();
        await loadVolumes();
        return;
      } else if (job.status === "error") {
        els.runOcr.disabled = false;
        setOcrStatus("OCR failed: " + (job.error || "unknown error"), "error");
        return;
      }
    } else {
      setOcrStatus("Waiting for OCR to start…");
    }

    await sleep(1500);
  }

  els.runOcr.disabled = false;
  setOcrStatus("OCR timed out.", "error");
}

function setOcrStatus(msg, cls = "") {
  els.ocrProgress.textContent = msg;
  els.ocrProgress.className = "ocr-progress" + (cls ? " " + cls : "");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════
// Tap-to-select-a-word
//
// The OCR layer is `pointer-events: none` so that dragging over the
// artwork still scrolls the reader — essential for a webtoon. That means
// we get no DOM event target, so we hit-test the word rects ourselves.
//
// A tap is a touch/click that does not move much and does not last long
// (i.e. it was not a scroll or a long-press selection).
// ═══════════════════════════════════════════════════════════════

const TAP_SLOP = 12;       // px of movement still counted as a tap
const TAP_TIME = 500;      // ms

function onPointerDown(e) {
  if (!state.ocr) return;
  state.tapPoint = { x: e.clientX, y: e.clientY, t: Date.now() };
}

function onPointerUp(e) {
  if (!state.ocr || !state.tapPoint) return;

  const dx = Math.abs(e.clientX - state.tapPoint.x);
  const dy = Math.abs(e.clientY - state.tapPoint.y);
  const dt = Date.now() - state.tapPoint.t;
  state.tapPoint = null;

  // Movement means the user was scrolling, not tapping.
  if (dx > TAP_SLOP || dy > TAP_SLOP) return;
  // A long press is the browser's own selection gesture — leave it alone.
  if (dt > TAP_TIME) return;

  // In READ mode the layer takes pointer events and the browser handles
  // selection natively, so we must not hijack the tap.
  if (state.ocrMode === "read") return;

  handleCharTap(e.clientX, e.clientY);
}

els.reader.addEventListener("pointerdown", onPointerDown, { passive: true });
els.reader.addEventListener("pointerup", onPointerUp, { passive: true });
// A touch drag should never trigger a tap.
els.reader.addEventListener("pointercancel", () => { state.tapPoint = null; }, { passive: true });

// ═══════════════════════════════════════════════════════════════
// OCR transcript panel
//
// The overlay text is transparent and sits on top of the artwork, so you
// can select it but you cannot *read* it in one place. This panel lists
// every OCR section on its own line — one line per detected section,
// one line per detected line within a section — grouped by page.
//
// Each line is real selectable text (not a canvas or an image), so the
// usual text selection, copy and translate tools all work.
// ═══════════════════════════════════════════════════════════════

function toggleTranscript(on) {
  const show = on ?? !els.transcript.hidden;
  if (show) {
    renderTranscript();
    els.transcript.hidden = false;
    requestAnimationFrame(() => els.transcript.classList.add("open"));
  } else {
    els.transcript.classList.remove("open");
    setTimeout(() => { els.transcript.hidden = true; }, 220);
  }
  els.textToggle.setAttribute("aria-pressed", show ? "true" : "false");
}

function renderTranscript() {
  els.transcriptBody.innerHTML = "";
  state.transcriptChars = [];
  const data = state.ocrData;
  if (!data || !data.pages?.length) {
    const p = document.createElement("p");
    p.className = "transcript-empty";
    p.textContent = state.volume
      ? "No OCR data for this volume yet. Open the library and press RUN OCR."
      : "Open a volume first.";
    els.transcriptBody.appendChild(p);
    return;
  }

  let sectionCount = 0;
  let lineCount = 0;

  for (let i = 0; i < data.pages.length; i++) {
    const page = data.pages[i];
    const blocks = page.blocks || [];
    if (!blocks.length) continue;

    // Page heading, so the sections are grouped and findable.
    const h = document.createElement("h3");
    h.className = "transcript-page";
    h.textContent = `Page ${i + 1}`;
    els.transcriptBody.appendChild(h);

    for (const block of blocks) {
      const lines = block.lines || [];
      for (const lineText of lines) {
        if (!lineText.trim()) continue;

        // One OCR section per line. A section that spans several detected
        // lines contributes several rows here — each on its own line.
        const row = document.createElement("p");
        row.className = "transcript-line";
        if (block.vertical) row.classList.add("vertical");

        // Character spans, so each character stays individually selectable
        // here too — same behaviour as the overlay.
        const spans = buildCharSpans(lineText);
        row.append(...spans);
        for (const s of spans) state.transcriptChars.push(s);

        els.transcriptBody.appendChild(row);
        lineCount++;
      }
      sectionCount++;
    }
  }

  const meta = document.createElement("p");
  meta.className = "transcript-meta";
  meta.textContent = `${sectionCount} section${sectionCount === 1 ? "" : "s"} · ${lineCount} line${lineCount === 1 ? "" : "s"}`;
  els.transcriptBody.prepend(meta);
}

els.textToggle.addEventListener("click", () => toggleTranscript());
els.textPanelBtn.addEventListener("click", () => {
  toggleTranscript(true);
});
els.transcriptClose.addEventListener("click", () => toggleTranscript(false));

// Clicking a character in the transcript highlights it, the same way the
// overlay does. The panel is a normal scrolling region, so this uses the
// browser's own event target rather than hit-testing.
//
// Clicking away from a character (on the panel's background, or on a
// page heading) clears the highlight.
//
// The characters are `user-select: none` (see styles.css), so a click
// does not make the browser select the character. The line itself keeps
// `user-select: text`, so a long-press drag still selects a run of text.
els.transcriptBody.addEventListener("click", (e) => {
  const ch = e.target.closest(".ocr-char");
  const tapped = els.transcriptBody.querySelectorAll(".ocr-char.tapped");
  for (const c of tapped) c.classList.remove("tapped");

  if (ch) ch.classList.add("tapped");

  // Clicked off the text: clear the selection too.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) sel.removeAllRanges();
});

/**
 * ═══════════════════════════════════════════════════════════════
 * Add-on API
 * ═══════════════════════════════════════════════════════════════
 *
 * A browser add-on (Firefox extension, userscript, etc.) needs to find
 * the OCR characters under a point and read them back. The overlay is
 * `pointer-events: none` in tap mode — deliberately, so that dragging
 * over the artwork scrolls the page instead of selecting text — which
 * means `document.elementFromPoint()` will NOT return a character.
 *
 * So we expose a small, stable API. From an add-on's console:
 *
 *     MANGA_CAB.hitTest(x, y)      // the character under a point
 *     MANGA_CAB.getCharacters()    // every character, with its rect
 *     MANGA_CAB.getLines()         // every OCR section (a line of text)
 *     MANGA_CAB.getTranscript()    // the whole volume, grouped by page
 *
 * Every character element also carries data attributes:
 *
 *     data-ocr-char   the character itself
 *     data-ocr-page   0-based page index
 *     data-ocr-block  0-based text block index within the page
 *     data-ocr-line   0-based line index within the block
 *
 * so an add-on can find them with a plain CSS selector, and in READ mode
 * `document.elementFromPoint()` works too.
 */

const MANGA_CAB = {
  /** The character element under a viewport point, or null. */
  hitTest(x, y) {
    return charAtPoint(x, y);
  },

  /** Every character element currently rendered, with its rect. */
  getCharacters() {
    return state.chars.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        char: el.textContent,
        text: el.textContent,
        page: Number(el.dataset.ocrPage),
        block: Number(el.dataset.ocrBlock),
        line: Number(el.dataset.ocrLine),
        el,
        x: r.left, y: r.top, width: r.width, height: r.height,
        centerX: r.left + r.width / 2,
        centerY: r.top + r.height / 2,
      };
    });
  },

  /**
   * Every OCR section (one detected line), with its characters and rect.
   * This is what an add-on wants: the text of a speech bubble, not
   * individual characters.
   */
  getLines() {
    const out = [];
    for (const box of document.querySelectorAll(".ocr-box")) {
      for (const line of box.querySelectorAll(".ocr-line")) {
        const r = line.getBoundingClientRect();
        out.push({
          text: line.textContent,
          page: Number(line.dataset.ocrPage),
          block: Number(box.dataset.ocrBlock),
          line: Number(line.dataset.ocrLine),
          el: line,
          x: r.left, y: r.top, width: r.width, height: r.height,
        });
      }
    }
    return out;
  },

  /** The whole volume's OCR, grouped by page. */
  getTranscript() {
    const data = state.ocrData;
    if (!data?.pages) return [];
    return data.pages.map((page, i) => ({
      page: i,
      sections: (page.blocks || []).flatMap((b) =>
        (b.lines || [])
          .filter((l) => l.trim())
          .map((text, li) => ({
            text,
            vertical: !!b.vertical,
            box: b.box,
            fontSize: b.font_size,
            line: li,
          }))
      ),
    }));
  },

  /** The current display mode: "off" | "tap" | "read". */
  getMode() {
    return state.ocrMode;
  },

  /**
   * Every clickable text zone, with its rect and text.
   *
   * A zone is the area of the artwork where one detected text block
   * lives. Tapping a zone reveals it — the text is drawn on white so it
   * can be read.
   */
  getZones() {
    return Array.from(document.querySelectorAll(".ocr-box")).map((box, i) => {
      const r = zoneRect(box);
      const lines = Array.from(box.querySelectorAll(".ocr-line"));
      return {
        index: i,
        text: box.textContent,
        page: Number(box.dataset.ocrPage ?? -1),
        block: Number(box.dataset.ocrBlock ?? -1),
        el: box,
        revealed: box.classList.contains("revealed"),
        lines: lines.map((l) => l.textContent),
        x: r ? r.left : 0, y: r ? r.top : 0,
        width: r ? r.width : 0, height: r ? r.height : 0,
      };
    });
  },

  /** The zone under a viewport point, or null. */
  hitZone(x, y) {
    const z = zoneAtPoint(x, y);
    if (!z) return null;
    return {
      el: z.box,
      text: z.box.textContent,
      page: Number(z.box.dataset.ocrPage ?? -1),
      block: Number(z.box.dataset.ocrBlock ?? -1),
      revealed: z.box.classList.contains("revealed"),
      x: z.rect.left, y: z.rect.top,
      width: z.rect.width, height: z.rect.height,
    };
  },

  /** Reveal a zone by index (from getZones()). */
  revealZone(index) {
    const boxes = document.querySelectorAll(".ocr-box");
    if (index < 0 || index >= boxes.length) return false;
    revealZone(boxes[index]);
    return true;
  },

  /** Collapse every revealed zone. */
  collapseZones() {
    collapseZones();
  },

  /** Switch display mode from an add-on. */
  setMode(mode) {
    setOcrMode(mode);
    return state.ocrMode;
  },

  /** Force the overlay on or off. */
  setOverlay(on) {
    setOcr(!!on);
    return state.ocr;
  },

  /** Is the reader currently showing a volume? */
  isReading() {
    return !!state.volume;
  },

  /** The volume currently open, or null. */
  getVolume() {
    return state.volume ? { id: state.volume.id, title: state.volume.title, pageCount: state.volume.pageCount } : null;
  },
};

window.MANGA_CAB = MANGA_CAB;

// ═══════════════════════════════════════════════════════════════
// Fullscreen
// ═══════════════════════════════════════════════════════════════

els.fsBtn.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

// ═══════════════════════════════════════════════════════════════
// Keyboard
// ═══════════════════════════════════════════════════════════════

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) return;

  if (e.key === "Escape") {
    // Escape backs out one layer at a time: sheet, then transcript, then
    // the reader itself.
    if (els.ocrSheet.classList.contains("open")) { closeSheet(); return; }
    if (!els.transcript.hidden) { toggleTranscript(false); return; }
    if (els.app.classList.contains("view-reader")) { showShelf(); return; }
    return;
  }
  if (e.key === "ArrowRight" || e.key === "PageDown") {
    els.reader.scrollBy({ top: els.reader.clientHeight * 0.9, behavior: "smooth" });
  }
  if (e.key === "ArrowLeft" || e.key === "PageUp") {
    els.reader.scrollBy({ top: -els.reader.clientHeight * 0.9, behavior: "smooth" });
  }
  if (e.key === "Home") els.reader.scrollTo({ top: 0, behavior: "smooth" });
  if (e.key === "End") els.reader.scrollTo({ top: els.reader.scrollHeight, behavior: "smooth" });
  if (e.key === "o" || e.key === "O") setOcr(!state.ocr);
  if (e.key === "t" || e.key === "T") toggleTranscript();
  if (e.key === "b" || e.key === "B") showShelf();
});

// Expose a small surface for the headless test harness.
window.openVolume = openVolume;
window.setOcr = setOcr;
window.setOcrMode = setOcrMode;
window.showShelf = showShelf;
window.showReader = showReader;
window.attachMokuro = attachMokuro;
window.toggleTranscript = toggleTranscript;
window.toggleSheet = toggleSheet;
window.state = state;

// Start on the shelf — that is the main menu.
setOcrMode("tap");
showShelf();
