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
};

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
      box.style.height = ((y1 - y0) / H) * 100 + "%";
      box.style.setProperty("--ocr-size", (block.font_size || 16) + "px");

      if (block.vertical) {
        box.style.writingMode = "vertical-rl";
        box.style.textAlign = "start";
      }

      const text = (block.lines || []).join("\n");
      box.textContent = text;
      layer.appendChild(box);
    }
  }
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
