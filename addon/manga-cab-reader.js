// ═══════════════════════════════════════════════════════════════
// MANGA.CAB — Firefox add-on (content script)
//
// Tap a speech bubble on a webtoon and read it.
//
// The page exposes a `MANGA_CAB` API for exactly this purpose:
//
//   MANGA_CAB.hitTest(x, y)     the character under a viewport point
//   MANGA_CAB.getCharacters()   every character, with its rect
//   MANGA_CAB.getLines()        every OCR section (one speech bubble)
//   MANGA_CAB.getTranscript()   the whole volume, grouped by page
//
// In TAP mode the overlay is `pointer-events: none` so that dragging
// over the artwork scrolls the page — which means
// `document.elementFromPoint()` returns the artwork, not the text. So we
// use MANGA_CAB.hitTest() instead.
//
// Load it: about:debugging → This Firefox → Load Temporary Add-on →
// pick manifest.json in this folder.
//
// ═══════════════════════════════════════════════════════════════

(() => {
  "use strict";

  const PANEL_ID = "manga-cab-reader";
  let panel = null;

  // ── Is the MANGA.CAB API available on this page? ─────────────
  const hasApi = () => typeof window.MANGA_CAB?.hitTest === "function";

  // ── Find the OCR section (speech bubble) under a point ───────
  //
  // A character knows its page, block and line. So: hit-test the
  // character, then find the line element it belongs to. That gives the
  // whole sentence, not just one character.
  function sectionAt(x, y) {
    if (!hasApi()) return null;

    const ch = window.MANGA_CAB.hitTest(x, y);
    if (!ch) return null;

    const line = ch.closest(".ocr-line");
    if (!line) return { text: ch.textContent, char: ch.textContent };

    const box = line.closest(".ocr-box");
    const page = Number(line.dataset.ocrPage);

    return {
      text: line.textContent,
      char: ch.textContent,
      page,
      block: Number(box?.dataset.ocrBlock ?? 0),
      line: Number(line.dataset.ocrLine ?? 0),
      vertical: getComputedStyle(box || line).writingMode?.startsWith("vertical") ?? false,
      rect: line.getBoundingClientRect(),
      charRect: ch.getBoundingClientRect(),
    };
  }

  // ── The reading panel ────────────────────────────────────────
  function ensurePanel() {
    if (panel && document.body.contains(panel)) return panel;

    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.setAttribute("role", "status");
    panel.style.cssText = `
      position: fixed;
      left: 50%;
      bottom: calc(18px + env(safe-area-inset-bottom, 0px));
      transform: translateX(-50%);
      max-width: min(92vw, 620px);
      z-index: 2147483647;
      background: rgba(16, 16, 20, 0.96);
      color: #ececf1;
      border: 1px solid #3a3a46;
      border-radius: 12px;
      padding: 12px 14px;
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 10px 34px rgba(0,0,0,.6);
      display: none;
      white-space: pre-wrap;
      word-break: break-word;
      -webkit-user-select: text;
      user-select: text;
      cursor: text;
    `;
    document.body.appendChild(panel);
    return panel;
  }

  function showPanel(html) {
    const p = ensurePanel();
    p.innerHTML = html;
    p.style.display = "block";
  }

  function hidePanel() {
    if (panel) panel.style.display = "none";
  }

  // ── Tap handling ─────────────────────────────────────────────
  //
  // We listen in the capture phase on pointerup. A tap is a pointer that
  // barely moved and was not held. If the user was scrolling or
  // long-pressing, we stay out of the way.
  const TAP_SLOP = 12;
  const TAP_TIME = 600;
  let down = null;

  window.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY, t: Date.now() };
  }, true);

  window.addEventListener("pointerup", (e) => {
    if (!down || !hasApi()) { down = null; return; }

    const dx = Math.abs(e.clientX - down.x);
    const dy = Math.abs(e.clientY - down.y);
    const dt = Date.now() - down.t;
    down = null;

    // A drag was a scroll.
    if (dx > TAP_SLOP || dy > TAP_SLOP) return;
    // A long press is the browser's own selection.
    if (dt > TAP_TIME) return;
    // Only left/touch.
    if (e.button !== 0 && e.pointerType === "mouse") return;

    const sec = sectionAt(e.clientX, e.clientY);
    if (!sec) { hidePanel(); return; }

    // Build the panel. The whole sentence, with the tapped character
    // highlighted so you can see exactly where you tapped.
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const marked = esc(sec.text).split(esc(sec.char)).join(
      `<mark style="background:#ff4d6d;color:#fff;border-radius:3px;padding:0 2px">${esc(sec.char)}</mark>`
    );

    showPanel(
      `<div style="font-size:11px;letter-spacing:1.5px;color:#9a9aab;margin-bottom:4px">` +
      `PAGE ${sec.page + 1} &middot; SECTION ${sec.block + 1}</div>` +
      `<div>${marked}</div>`
    );

    // Select the whole sentence so the browser's copy button works.
    try {
      const range = document.createRange();
      const el = sec.rect && document.querySelector(`.ocr-char[data-ocr-page="${sec.page}"][data-ocr-block="${sec.block}"][data-ocr-line="${sec.line}"]`);
      if (el) {
        const chars = Array.from(el.parentElement.querySelectorAll(".ocr-char"));
        const target = chars.find((c) => c.textContent === sec.char);
        if (target) {
          range.selectNodeContents(target);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    } catch { /* selection is a nicety, not required */ }
  }, true);

  // Hide the panel when tapping empty space.
  window.addEventListener("pointerdown", (e) => {
    if (panel && panel.style.display === "block" && !panel.contains(e.target)) {
      // Don't hide immediately — the pointerup handler may want to
      // update it. Defer to the next frame.
      setTimeout(() => {
        if (down) return; // a new tap started
        const sec = sectionAt(e.clientX, e.clientY);
        if (!sec) hidePanel();
      }, 60);
    }
  }, true);

  // ── Escape closes the panel ──────────────────────────────────
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hidePanel();
  }, true);

  // ── Keyboard shortcut: read the section under the mouse ──────
  window.addEventListener("keydown", (e) => {
    if (e.key !== "r" && e.key !== "R") return;
    if (e.target.matches?.("input, textarea")) return;
    const sec = sectionAt(e.clientX, e.clientY);
    if (!sec) return;
    e.preventDefault();
    showPanel(
      `<div style="font-size:11px;letter-spacing:1.5px;color:#9a9aab;margin-bottom:4px">` +
      `PAGE ${sec.page + 1} &middot; SECTION ${sec.block + 1}</div>` +
      `<div>${String(sec.text).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</div>`
    );
  }, true);

  console.info("[MANGA.CAB reader] content script loaded");
})();
