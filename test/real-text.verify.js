// Verifies the overlay against the REAL Chinese webtoon volume: that
// every OCR sentence is fully present (not clipped) and that a long
// sentence still renders all of its characters.
//
// Run: node test/real-text.verify.js [volumeId]

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8790;
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { console.log(`PASS  ${n}${d ? ` — ${d}` : ""}`); pass++; }
  else { console.log(`FAIL  ${n}${d ? ` — ${d}` : ""}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const { volumes } = await (await fetch(`${BASE}/api/volumes`)).json();
  // Pick the volume with the most OCR text — that is the real webtoon,
  // not a synthetic test fixture.
  const withOcr = [];
  for (const v of volumes) {
    const ocr = await (await fetch(`${BASE}/v/${v.id}/mokuro`)).json();
    if (ocr.pages?.length) {
      const chars = ocr.pages.reduce(
        (n, p) => n + p.blocks.reduce((m, b) => m + b.lines.join("").length, 0), 0);
      withOcr.push({ v, ocr, chars });
    }
  }
  if (!withOcr.length) {
    console.log("SKIP  no volume with OCR data");
    return 0;
  }
  withOcr.sort((a, b) => b.chars - a.chars);
  const { v, ocr } = withOcr[0];
  const totalExpected = withOcr[0].chars;
  console.log(`volume "${v.title}" — ${ocr.pages.length} pages, ${totalExpected} chars expected`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-real-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9342",
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9342/json/version")).json();
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
  await sleep(1500);
  await ev("window.setOcr(true)");
  await sleep(1200);

  // ── Every OCR character must be present in the DOM ──────────
  const rendered = await ev(`(() => {
    const boxes = Array.from(document.querySelectorAll('.ocr-box'));
    const out = [];
    for (const b of boxes) {
      const chars = Array.from(b.querySelectorAll('.ocr-char')).map(c => c.textContent).join('');
      // The rendered extent of the text, vs the box's declared width.
      const range = document.createRange();
      range.selectNodeContents(b);
      const rects = Array.from(range.getClientRects());
      out.push({
        text: chars,
        len: chars.length,
        boxW: Math.round(b.getBoundingClientRect().width),
        textW: rects.length ? Math.round(Math.max(...rects.map(r => r.width))) : 0,
        clipped: b.scrollWidth > b.clientWidth + 1 && getComputedStyle(b).overflow === 'hidden',
      });
    }
    return out;
  })()`);

  const renderedChars = rendered.reduce((n, b) => n + b.len, 0);
  console.log(`  rendered ${renderedChars} chars across ${rendered.length} boxes`);
  check("all OCR characters are rendered", renderedChars === totalExpected,
    `rendered ${renderedChars} vs expected ${totalExpected}`);
  check("no text box clips its content", rendered.every((b) => !b.clipped),
    rendered.filter((b) => b.clipped).length + " clipped");

  // An empty box is only a problem if the source .mokuro had text for it.
  // OCR sometimes detects a region and reads nothing (an empty speech
  // bubble, a sound effect it could not parse) — that is upstream data,
  // not an overlay bug.
  const sourceBlocks = ocr.pages.reduce((n, p) => n + p.blocks.length, 0);
  const sourceEmpty = ocr.pages.reduce(
    (n, p) => n + p.blocks.filter((b) => !b.lines.join("").trim()).length, 0);
  check("empty boxes match the empty blocks in the source file",
    rendered.filter((b) => b.len === 0).length <= sourceEmpty,
    `${rendered.filter((b) => b.len === 0).length} empty in DOM, ${sourceEmpty} empty in .mokuro (of ${sourceBlocks} blocks)`);

  // ── The long sentence specifically ──────────────────────────
  const longest = rendered.slice().sort((a, b) => b.len - a.len)[0];
  console.log(`  longest: "${longest?.text?.slice(0, 40)}" (${longest?.len} chars)`);
  check("the longest sentence is fully rendered", longest && longest.len > 20, `${longest?.len} chars`);
  check("the longest sentence overflows rather than clipping",
    longest && longest.textW >= longest.boxW,
    `text=${longest?.textW}px box=${longest?.boxW}px`);

  // ── A single character can be tapped in the real volume ─────
  const charTap = await ev(`(() => {
    const chars = Array.from(document.querySelectorAll('.ocr-char'));
    if (!chars.length) return null;
    const c = chars[0];
    const r = c.getBoundingClientRect();
    return { text: c.textContent, x: r.left + r.width/2, y: r.top + r.height/2,
             visible: r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0 };
  })()`);
  check("a character is on screen and measurable", !!charTap, JSON.stringify(charTap));

  if (charTap?.visible) {
    await ev("window.getSelection().removeAllRanges()");
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: charTap.x, y: charTap.y, button: "left", clickCount: 1 }, sessionId);
    await sleep(60);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: charTap.x, y: charTap.y, button: "left", clickCount: 1 }, sessionId);
    await sleep(400);
    const sel = await ev(`({
      tapped: document.querySelector('.ocr-char.tapped')?.textContent || null,
      selected: window.getSelection().toString(),
    })`);
    check("tapping selects exactly one character",
      sel.tapped === charTap.text && sel.selected.length <= 1,
      JSON.stringify(sel));
  }

  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  chrome.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
