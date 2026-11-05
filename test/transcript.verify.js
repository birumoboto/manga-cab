// Verifies the OCR transcript panel: every OCR section appears on its
// own line, all characters are present, and the text is selectable.
//
// Run: node test/transcript.verify.js

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8790;
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
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
  // Find the volume with the most OCR text — the real webtoon.
  const { volumes } = await (await fetch(`${BASE}/api/volumes`)).json();
  const withOcr = [];
  for (const v of volumes) {
    const ocr = await (await fetch(`${BASE}/v/${v.id}/mokuro`)).json();
    if (ocr.pages?.length) {
      const chars = ocr.pages.reduce((n, p) => n + p.blocks.reduce((m, b) => m + b.lines.join("").length, 0), 0);
      withOcr.push({ v, ocr, chars });
    }
  }
  if (!withOcr.length) { console.log("SKIP  no volume with OCR data"); return 0; }
  withOcr.sort((a, b) => b.chars - a.chars);
  const { v, ocr } = withOcr[0];

  // Expected: one transcript line per non-empty OCR line.
  const expectedLines = [];
  for (const p of ocr.pages) {
    for (const b of p.blocks || []) {
      for (const line of b.lines || []) {
        if (line.trim()) expectedLines.push(line);
      }
    }
  }
  const expectedChars = expectedLines.reduce((n, l) => n + l.length, 0);
  console.log(`volume "${v.title}" — ${expectedLines.length} lines, ${expectedChars} chars expected`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-tr-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9345",
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9345/json/version")).json();
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

  await ev(`window.openVolume('${v.id}')`);
  await sleep(1800);

  // ── The button exists ───────────────────────────────────────
  check("the transcript toggle button exists",
    await ev(`!!document.getElementById('textToggle')`));
  check("the transcript panel exists",
    await ev(`!!document.getElementById('transcript')`));

  // ── Open it ─────────────────────────────────────────────────
  // Use the exposed function rather than a synthetic click, so the test is
  // not racing the library drawer's close animation.
  await ev("window.toggleTranscript(true)");
  await sleep(700);

  const panel = await ev(`(() => {
    const p = document.getElementById('transcript');
    const r = p.getBoundingClientRect();
    return {
      hidden: p.hidden,
      open: p.classList.contains('open'),
      onScreen: r.left < window.innerWidth && r.right > 0 && r.width > 100,
      w: Math.round(r.width), h: Math.round(r.height),
      pressed: document.getElementById('textToggle').getAttribute('aria-pressed'),
    };
  })()`);
  check("the panel opens", !panel.hidden && panel.open, JSON.stringify(panel));
  check("the panel is on screen", panel.onScreen, JSON.stringify(panel));
  check("the toggle button reports its state",
    panel.pressed === "true", `aria-pressed=${panel.pressed}`);

  // ── One section per line ────────────────────────────────────
  const lines = await ev(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('.transcript-line')) {
      const chars = Array.from(el.querySelectorAll('.ocr-char')).map(c => c.textContent);
      const r = el.getBoundingClientRect();
      out.push({
        text: el.textContent,
        charCount: chars.length,
        x: Math.round(r.left),
        y: Math.round(r.top),
        h: Math.round(r.height),
        display: getComputedStyle(el).display,
      });
    }
    return out;
  })()`);

  check("every OCR line has its own element", lines.length === expectedLines.length,
    `${lines.length} rendered vs ${expectedLines.length} expected`);
  check("every element is a block on its own line",
    lines.every((l) => l.display === "block"), JSON.stringify([...new Set(lines.map((l) => l.display))]));
  check("each element holds exactly the characters of one OCR line",
    lines.every((l, i) => l.text === expectedLines[i]),
    lines.length && lines[0].text !== expectedLines[0]
      ? `first mismatch: "${lines[0].text}" vs "${expectedLines[0]}"`
      : "all match");

  // Each line must sit on a distinct Y row (no two lines on the same row).
  const ys = lines.map((l) => l.y);
  const distinctY = new Set(ys).size;
  check("no two OCR sections share a row", distinctY === ys.length,
    `${distinctY} distinct rows for ${ys.length} lines`);

  // ── All characters present and individually selectable ───────
  const totalChars = lines.reduce((n, l) => n + l.charCount, 0);
  check("every character is rendered", totalChars === expectedChars,
    `${totalChars} rendered vs ${expectedChars} expected`);

  const charSel = await ev(`(() => {
    const cs = Array.from(document.querySelectorAll('.transcript-line .ocr-char'));
    const line = document.querySelector('.transcript-line');
    const lcs = getComputedStyle(line);
    return {
      count: cs.length,
      userSelect: lcs.userSelect,
      webkitUserSelect: lcs.webkitUserSelect,
      color: lcs.color,
    };
  })()`);
  check("characters are individually selectable",
    charSel && (charSel.userSelect === "text" || charSel.webkitUserSelect === "text"),
    JSON.stringify(charSel));
  check("the transcript text is visible (not transparent)",
    charSel && charSel.color !== "rgba(0, 0, 0, 0)" && !charSel.color.includes("0.001"),
    `color=${charSel?.color}`);

  // ── Tapping a character highlights it ───────────────────────
  const tapped = await ev(`(() => {
    const c = document.querySelector('.transcript-line .ocr-char');
    if (!c) return null;
    c.click();
    const t = document.querySelector('.transcript-line .ocr-char.tapped');
    return { text: c.textContent, tapped: t?.textContent || null, selected: window.getSelection().toString() };
  })()`);
  check("tapping a character highlights it",
    tapped && tapped.tapped === tapped.text, JSON.stringify(tapped));

  // ── Page grouping ───────────────────────────────────────────
  const headings = await ev(`document.querySelectorAll('.transcript-page').length`);
  const pagesWithText = ocr.pages.filter((p) => (p.blocks || []).some((b) => (b.lines || []).some((l) => l.trim()))).length;
  check("pages are grouped with headings", headings === pagesWithText,
    `${headings} headings vs ${pagesWithText} pages with text`);

  // ── The panel scrolls, it does not grow off screen ──────────
  const scrollInfo = await ev(`(() => {
    const b = document.getElementById('transcriptBody');
    return { scrollH: b.scrollHeight, clientH: b.clientHeight, overflowY: getComputedStyle(b).overflowY };
  })()`);
  check("the transcript body scrolls", scrollInfo.overflowY === "auto" || scrollInfo.overflowY === "scroll",
    JSON.stringify(scrollInfo));
  check("the transcript body is bounded by the panel",
    scrollInfo.clientH <= panel.h, `body=${scrollInfo.clientH} panel=${panel.h}`);

  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  chrome.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
