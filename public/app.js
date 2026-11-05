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
  pages: $("pages"),
  empty: $("empty"),
  emptyUpload: $("emptyUpload"),
  title: $("volumeTitle"),
  meta: $("volumeMeta"),
  library: $("library"),
  libraryBtn: $("libraryBtn"),
  libraryClose: $("libraryClose"),
  scrim: $("scrim"),
  volumeList: $("volumeList"),
  dropZone: $("dropZone"),
  fileInput: $("fileInput"),
  folderInput: $("folderInput"),
  pickFiles: $("pickFiles"),
  pickFolder: $("pickFolder"),
  titleInput: $("titleInput"),
  uploadStatus: $("uploadStatus"),
  ocrToggle: $("ocrToggle"),
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
  ocr: false,
  ocrData: null,
  visible: new Set(),
  observer: null,
  chars: [],       // character spans in the OCR layer, for hit-testing
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
// Library drawer
// ═══════════════════════════════════════════════════════════════

function openLibrary() {
  els.library.classList.add("open");
  els.scrim.hidden = false;
  requestAnimationFrame(() => els.scrim.classList.add("show"));
  loadVolumes();
}

function closeLibrary() {
  els.library.classList.remove("open");
  els.scrim.classList.remove("show");
  setTimeout(() => { els.scrim.hidden = true; }, 220);
}

els.libraryBtn.addEventListener("click", openLibrary);
els.libraryClose.addEventListener("click", closeLibrary);
els.scrim.addEventListener("click", closeLibrary);
els.emptyUpload.addEventListener("click", () => {
  openLibrary();
  setTimeout(() => els.pickFolder.click(), 250);
});

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
  closeLibrary();
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
    layer.innerHTML = "";

    const page = byName.get(wrap.dataset.file) || pages[Number(wrap.dataset.index)];
    if (!page || !page.blocks) continue;

    const img = wrap.querySelector("img");
    const W = page.img_width || img.naturalWidth || 1;
    const H = page.img_height || img.naturalHeight || 1;

    for (const block of page.blocks) {
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
      }

      // Each line of the block gets its own line element so multi-line
      // blocks are not run together, and each character becomes a span so
      // it can be selected on its own.
      const lines = block.lines || [];
      for (const lineText of lines) {
        const line = document.createElement("div");
        line.className = "ocr-line";
        const spans = buildCharSpans(lineText);
        line.append(...spans);
        for (const s of spans) {
          if (s.classList?.contains("ocr-char")) state.chars.push(s);
        }
        box.appendChild(line);
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
 * Handle a tap on a character in the OCR layer.
 */
function handleCharTap(x, y) {
  const ch = charAtPoint(x, y);
  if (!ch) return false;

  // Clear any previous tap highlight.
  for (const w of document.querySelectorAll(".ocr-char.tapped")) {
    w.classList.remove("tapped");
  }
  ch.classList.add("tapped");

  // Also select it natively, so the browser's own copy menu works.
  const range = document.createRange();
  range.selectNodeContents(ch);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  showCopyHint(ch);
  return true;
}

/**
 * Show a small "Copied" toast near the tapped word.
 */
function showCopyHint(word) {
  let hint = document.getElementById("ocrCopyHint");
  if (!hint) {
    hint = document.createElement("div");
    hint.id = "ocrCopyHint";
    hint.className = "ocr-copy-hint";
    document.body.appendChild(hint);
  }

  const r = word.getBoundingClientRect();
  hint.textContent = "COPIED";
  hint.classList.add("show");

  // Position above the word, clamped to the viewport.
  const left = Math.max(12, Math.min(r.left + r.width / 2 - 34, window.innerWidth - 88));
  const top = Math.max(12, r.top - 34);
  hint.style.left = left + "px";
  hint.style.top = top + "px";

  clearTimeout(hint._timer);
  hint._timer = setTimeout(() => hint.classList.remove("show"), 1400);
}

function baseName(p) {
  const parts = String(p).replace(/\\/g, "/").split("/");
  return parts[parts.length - 1];
}

els.ocrToggle.addEventListener("click", () => setOcr(!state.ocr));

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

  handleCharTap(e.clientX, e.clientY);
}

els.reader.addEventListener("pointerdown", onPointerDown, { passive: true });
els.reader.addEventListener("pointerup", onPointerUp, { passive: true });
// A touch drag should never trigger a tap.
els.reader.addEventListener("pointercancel", () => { state.tapPoint = null; }, { passive: true });

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
    if (els.library.classList.contains("open")) closeLibrary();
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
});

// Expose a small surface for the headless test harness.
window.openVolume = openVolume;
window.setOcr = setOcr;
window.attachMokuro = attachMokuro;
window.state = state;

// Start with the library open so the upload path is obvious.
loadVolumes();
openLibrary();
