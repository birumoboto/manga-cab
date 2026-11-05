// Verifies the revamped UI:
//   - the shelf and the reader are two separate screens
//   - the reader has a visible, labelled BACK button
//   - the OCR display modes work (off / tap / read)
//   - the add-on API exposes the characters
//
// Run: node test/ui-revamp.verify.js

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE_URL || "http://127.0.0.1:8790";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { console.log(`PASS  ${n}${d ? ` — ${d}` : ""}`); pass++; }
  else { console.log(`FAIL  ${n}${d ? ` — ${d}` : ""}`); fail++; }
};

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    const c = new CDP(ws);
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && c.pending.has(m.id)) {
        const p = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => reject(new Error("timeout " + method)), 30000);
    });
  }
}

async function main() {
  // Pick the volume with the most OCR text — the real webtoon.
  const { volumes } = await (await fetch(`${BASE}/api/volumes`)).json();
  const withOcr = [];
  for (const v of volumes) {
    const ocr = await (await fetch(`${BASE}/v/${v.id}/mokuro`)).json();
    if (ocr.pages?.length) {
      const chars = ocr.pages.reduce((n, p) => n + p.blocks.reduce((m, b) => m + b.lines.join("").length, 0), 0);
      withOcr.push({ v, ocr, chars });
    }
  }
  withOcr.sort((a, b) => b.chars - a.chars);
  const { v } = withOcr[0];

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-revamp-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9348",
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9348/json/version")).json();
      if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(250);
  }
  if (!wsUrl) throw new Error("Chrome did not start");

  const cdp = await CDP.connect(wsUrl);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2, mobile: true }, sessionId);
  await cdp.send("Page.navigate", { url: BASE }, sessionId);
  await sleep(2500);

  const ev = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return "ERR " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // ── 1. The app starts on the SHELF ──────────────────────────
  const start = await ev(`(() => {
    const app = document.getElementById('app');
    const lib = document.getElementById('library');
    const rdr = document.getElementById('readerScreen');
    return {
      cls: app.className,
      libraryVisible: getComputedStyle(lib).display !== 'none',
      readerVisible: getComputedStyle(rdr).display !== 'none',
    };
  })()`);
  check("the app starts on the shelf", start.libraryVisible && !start.readerVisible, JSON.stringify(start));

  // The shelf must show the volume list.
  const shelf = await ev(`(() => {
    const items = document.querySelectorAll('#volumeList li');
    const r = document.getElementById('library').getBoundingClientRect();
    return { count: items.length, onScreen: r.width > 100 && r.height > 100 };
  })()`);
  check("the shelf lists the volumes", shelf.count > 0, `${shelf.count} volumes`);
  check("the shelf is on screen", shelf.onScreen, JSON.stringify(shelf));

  // ── 2. Opening a volume switches to the READER ─────────────
  await ev(`window.openVolume('${v.id}')`);
  await sleep(2000);

  const reader = await ev(`(() => {
    const app = document.getElementById('app');
    const lib = document.getElementById('library');
    const rdr = document.getElementById('readerScreen');
    return {
      cls: app.className,
      libraryVisible: getComputedStyle(lib).display !== 'none',
      readerVisible: getComputedStyle(rdr).display !== 'none',
      title: document.getElementById('volumeTitle').textContent,
    };
  })()`);
  check("opening a volume switches to the reader",
    reader.readerVisible && !reader.libraryVisible, JSON.stringify(reader));
  check("the reader shows the volume title", reader.title === v.title, reader.title);

  // ── 3. The BACK button ─────────────────────────────────────
  const back = await ev(`(() => {
    const b = document.getElementById('backBtn');
    if (!b) return { missing: true };
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    const label = b.querySelector('.back-label');
    return {
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, visibility: cs.visibility,
      label: label ? label.textContent.trim() : null,
      labelVisible: label ? getComputedStyle(label).display !== 'none' : false,
      inViewport: r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight,
      ariaLabel: b.getAttribute('aria-label'),
    };
  })()`);
  check("the back button exists", !back.missing, JSON.stringify(back));
  check("the back button is visible", back.display !== "none" && back.visibility === "visible",
    `display=${back.display} visibility=${back.visibility}`);
  check("the back button is on screen", back.inViewport,
    `x=${back.x} y=${back.y} w=${back.w}`);
  check("the back button is a good tap target", back.w >= 40 && back.h >= 36, `${back.w}x${back.h}`);
  check("the back button is LABELLED", back.label && back.labelVisible, `label="${back.label}"`);
  check("the back button has an aria-label", !!back.ariaLabel, back.ariaLabel);

  // ── 4. Back returns to the shelf ───────────────────────────
  await ev("document.getElementById('backBtn').click()");
  await sleep(600);

  const backHome = await ev(`(() => {
    const app = document.getElementById('app');
    const lib = document.getElementById('library');
    const rdr = document.getElementById('readerScreen');
    return {
      libraryVisible: getComputedStyle(lib).display !== 'none',
      readerVisible: getComputedStyle(rdr).display !== 'none',
      railHidden: document.getElementById('rail').hidden,
      indicatorHidden: document.getElementById('pageIndicator').hidden,
    };
  })()`);
  check("the back button returns to the shelf",
    backHome.libraryVisible && !backHome.readerVisible, JSON.stringify(backHome));
  check("the progress rail is hidden on the shelf", backHome.railHidden === true);
  check("the page indicator is hidden on the shelf", backHome.indicatorHidden === true);

  // The reader must still be one tap away — reopen and check again.
  await ev(`window.openVolume('${v.id}')`);
  await sleep(1800);
  check("the shelf -> reader -> shelf round trip works",
    await ev("document.getElementById('readerScreen').offsetParent !== null"));

  // ── 5. The OCR sheet ───────────────────────────────────────
  await ev("window.toggleSheet()");
  await sleep(500);
  const sheet = await ev(`(() => {
    const s = document.getElementById('ocrSheet');
    const r = s.getBoundingClientRect();
    const modes = Array.from(document.querySelectorAll('.mode-btn')).map(b => ({
      mode: b.dataset.mode, text: b.textContent.trim(),
      w: Math.round(b.getBoundingClientRect().width),
      h: Math.round(b.getBoundingClientRect().height),
    }));
    return {
      hidden: s.hidden, open: s.classList.contains('open'),
      onScreen: r.bottom <= window.innerHeight + 2 && r.height > 100,
      modes,
      runOcr: !!document.getElementById('runOcr'),
      lang: !!document.getElementById('langSelect'),
    };
  })()`);
  check("the OCR sheet opens", !sheet.hidden && sheet.open, JSON.stringify(sheet));
  check("the sheet is on screen", sheet.onScreen);
  check("the sheet has three display modes",
    sheet.modes.length === 3 && sheet.modes.every((m) => m.mode),
    JSON.stringify(sheet.modes.map((m) => m.mode)));
  check("the mode buttons are good tap targets",
    sheet.modes.every((m) => m.h >= 40), JSON.stringify(sheet.modes.map((m) => `${m.w}x${m.h}`)));
  check("the sheet has RUN OCR and a language picker", sheet.runOcr && sheet.lang);
  await ev("window.toggleSheet()");
  await sleep(400);

  // ── 6. The display modes ───────────────────────────────────
  await ev("window.setOcrMode('tap')");
  await sleep(1200);
  const tapMode = await ev(`(() => {
    const layer = document.querySelector('.ocr-layer');
    const box = document.querySelector('.ocr-box');
    const cs = getComputedStyle(box);
    return {
      mode: window.MANGA_CAB.getMode(),
      layerPE: getComputedStyle(layer).pointerEvents,
      textColor: cs.color,
      hasModeTap: layer.classList.contains('mode-tap'),
    };
  })()`);
  check("TAP mode is active", tapMode.mode === "tap", JSON.stringify(tapMode));
  check("TAP mode leaves the text invisible", tapMode.textColor.includes("0, 0, 0, 0") || /rgba\(.*0\)$/.test(tapMode.textColor),
    `color=${tapMode.textColor}`);
  check("TAP mode keeps the layer click-through (scrolling works)",
    tapMode.layerPE === "none", `pointer-events=${tapMode.layerPE}`);

  await ev("window.setOcrMode('read')");
  await sleep(1200);
  const readMode = await ev(`(() => {
    const layer = document.querySelector('.ocr-layer');
    const box = document.querySelector('.ocr-box');
    const cs = getComputedStyle(box);
    return {
      mode: window.MANGA_CAB.getMode(),
      layerPE: getComputedStyle(layer).pointerEvents,
      textColor: cs.color,
      hasModeRead: layer.classList.contains('mode-read'),
      userSelect: cs.userSelect,
    };
  })()`);
  check("READ mode is active", readMode.mode === "read", JSON.stringify(readMode));
  check("READ mode draws the text visibly",
    readMode.textColor !== "rgba(0, 0, 0, 0)" && !/rgba\(.*, 0\)$/.test(readMode.textColor),
    `color=${readMode.textColor}`);
  check("READ mode lets the browser select the text",
    readMode.layerPE === "auto" && readMode.userSelect === "text",
    `pointer-events=${readMode.layerPE} user-select=${readMode.userSelect}`);

  await ev("window.setOcrMode('off')");
  await sleep(800);
  const offMode = await ev(`(() => ({
    mode: window.MANGA_CAB.getMode(),
    overlayOn: window.state.ocr,
    chars: document.querySelectorAll('.ocr-char').length,
  }))()`);
  check("OFF mode turns the overlay off",
    offMode.mode === "off" && offMode.overlayOn === false, JSON.stringify(offMode));

  // ── 7. The add-on API ──────────────────────────────────────
  await ev("window.setOcrMode('tap')");
  await sleep(1200);

  const api = await ev(`(() => {
    const M = window.MANGA_CAB;
    if (!M) return { missing: true };
    const chars = M.getCharacters();
    const lines = M.getLines();
    const tr = M.getTranscript();
    return {
      missing: false,
      fns: ['hitTest','getCharacters','getLines','getTranscript','getMode','setMode','setOverlay','isReading','getVolume']
        .filter(k => typeof M[k] === 'function'),
      charCount: chars.length,
      firstChar: chars[0] ? { c: chars[0].char, x: chars[0].x, w: chars[0].width, h: chars[0].height, page: chars[0].page } : null,
      lineCount: lines.length,
      firstLine: lines[0] ? { t: lines[0].text, page: lines[0].page } : null,
      pages: tr.length,
      firstPageSections: tr[0] ? tr[0].sections.length : 0,
      volume: M.getVolume(),
      reading: M.isReading(),
    };
  })()`);
  check("the add-on API is exposed", !api.missing);
  check("the API has every documented function", api.fns.length === 9,
    `${api.fns.length}/9: ${api.fns.join(", ")}`);
  check("getCharacters returns characters with geometry",
    api.charCount > 0 && api.firstChar && api.firstChar.w > 0,
    `${api.charCount} chars, first=${JSON.stringify(api.firstChar)}`);
  check("getLines returns OCR sections",
    api.lineCount > 0 && api.firstLine?.t, `${api.lineCount} lines, first="${api.firstLine?.t}"`);
  check("getTranscript returns the volume grouped by page",
    api.pages > 0 && api.firstPageSections > 0,
    `${api.pages} pages, ${api.firstPageSections} sections on page 0`);
  check("the API reports the open volume", api.reading && api.volume?.title,
    JSON.stringify(api.volume));

  // ── 8. hitTest actually finds the character ─────────────────
  const hit = await ev(`(() => {
    const M = window.MANGA_CAB;
    const chars = M.getCharacters();
    // Find one that is actually on screen.
    const onScreen = chars.find(c => c.y > 0 && c.y < window.innerHeight && c.x > 0);
    if (!onScreen) return { none: true };
    const el = M.hitTest(onScreen.centerX, onScreen.centerY);
    const viaElFromPoint = document.elementFromPoint(onScreen.centerX, onScreen.centerY);
    return {
      expected: onScreen.char,
      got: el ? el.textContent : null,
      isChar: el ? el.classList.contains('ocr-char') : false,
      elementFromPoint: viaElFromPoint ? viaElFromPoint.className : null,
    };
  })()`);
  check("hitTest finds the character under a point",
    !hit.none && hit.got === hit.expected,
    JSON.stringify(hit));
  check("the hit character is a real .ocr-char element", hit.isChar === true);

  // ── 9. data attributes for a plain CSS selector ─────────────
  const attrs = await ev(`(() => {
    const el = document.querySelector('.ocr-char[data-ocr-page][data-ocr-line][data-ocr-block]');
    if (!el) return { missing: true };
    return {
      page: el.dataset.ocrPage,
      line: el.dataset.ocrLine,
      block: el.dataset.ocrBlock,
      text: el.textContent,
    };
  })()`);
  check("characters carry data-ocr-* attributes",
    !attrs.missing && attrs.page !== undefined && attrs.line !== undefined && attrs.block !== undefined,
    JSON.stringify(attrs));

  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  chrome.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
