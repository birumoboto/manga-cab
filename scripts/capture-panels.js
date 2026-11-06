/**
 * Capture REAL rendered pixels of the OCR overlay over the artwork.
 *
 * For every page with OCR text, three viewport screenshots are taken
 * with the SAME crop:
 *
 *   1. artwork only   (the overlay layer hidden)
 *   2. overlay only   (the artwork hidden, the overlay on black)
 *   3. artwork + overlay
 *
 * These are actual screenshots of the running app, not a canvas
 * re-render, so what is measured is exactly what the reader draws.
 *
 * The reader is a scrollable DIV, not the document, so the crop is
 * taken from the viewport screenshot using the page's on-screen rect.
 *
 * Usage:
 *   node scripts/capture-panels.js [volume-id] [out-dir]
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:8790";
const VOLUME = process.argv[2] || "mw383dg7-5c0ce6cb";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = process.argv[3] || path.join(REPO, "shots", "panels");
const DSF = 2; // device scale factor

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
    const id = ++this.id; const pl = { id, method, params };
    if (sessionId) pl.sessionId = sessionId;
    this.ws.send(JSON.stringify(pl));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => rej(new Error("timeout " + method)), 60000);
    });
  }
}

fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pan-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=9391", `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--hide-scrollbars",
  `--force-device-scale-factor=${DSF}`, "--window-size=820,1200", "about:blank",
], { stdio: "ignore" });

let wsUrl;
for (let i = 0; i < 60; i++) {
  try {
    const j = await (await fetch("http://127.0.0.1:9391/json/version")).json();
    if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(250);
}
const cdp = await CDP.connect(wsUrl);
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
await cdp.send("Page.enable", {}, sessionId);
await cdp.send("Runtime.enable", {}, sessionId);
await cdp.send("Network.enable", {}, sessionId);
await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
await cdp.send("Emulation.setDeviceMetricsOverride",
  { width: 820, height: 1200, deviceScaleFactor: DSF, mobile: false }, sessionId);

await cdp.send("Page.navigate", { url: BASE + "/" }, sessionId);
await sleep(2500);
const ev = async (e) => {
  const r = await cdp.send("Runtime.evaluate",
    { expression: e, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) return "ERR " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

await ev(`window.openVolume(${JSON.stringify(VOLUME)})`);
await sleep(2000);
await ev(`window.setOcrMode("read")`);
await sleep(2500);

const pages = await ev(`(async () => {
  const out = [];
  const ps = Array.from(document.querySelectorAll('.page'));
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const img = p.querySelector('img');
    if (!img.complete || !img.naturalWidth) continue;
    const lines = p.querySelectorAll('.ocr-line.placed').length;
    if (!lines) continue;
    out.push({ index: i, lines });
  }
  return out;
})()`);
console.log("pages with OCR:", pages.map((p) => p.index + 1).join(", "));

const shoot = async (file) => {
  const { data } = await cdp.send("Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false }, sessionId);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
};

const manifest = [];

for (const p of pages) {
  const tag = String(p.index + 1).padStart(2, "0");

  // Scroll the page to the top of the reader so it is fully in view.
  await ev(`(() => {
    const page = document.querySelectorAll('.page')[${p.index}];
    const reader = document.querySelector('.reader') || document.querySelector('#reader');
    const pr = page.getBoundingClientRect();
    const rr = reader.getBoundingClientRect();
    reader.scrollTop += (pr.top - rr.top);
    return 1;
  })()`);
  await sleep(900);

  // The page's on-screen rect, so the crops line up.
  const rect = await ev(`(() => {
    const page = document.querySelectorAll('.page')[${p.index}];
    const img = page.querySelector('img');
    const r = img.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  if (!rect || rect.w < 10) { console.log(`  page ${p.index + 1}: no rect`); continue; }

  // 1) artwork only
  await ev(`document.querySelectorAll('.page')[${p.index}].querySelector('.ocr-layer').style.visibility='hidden'`);
  await sleep(250);
  await shoot(path.join(OUT, `p${tag}-art.png`));

  // 2) overlay only — artwork hidden, overlay on black.
  await ev(`(() => {
    const page = document.querySelectorAll('.page')[${p.index}];
    page.querySelector('img').style.visibility = 'hidden';
    page.style.background = '#000';
    page.querySelector('.ocr-layer').style.visibility = '';
    page.querySelector('.ocr-layer').style.background = '#000';
    page.querySelector('.ocr-layer').style.opacity = '1';
  })()`);
  await sleep(250);
  await shoot(path.join(OUT, `p${tag}-ov.png`));

  // 3) artwork + overlay
  await ev(`(() => {
    const page = document.querySelectorAll('.page')[${p.index}];
    page.querySelector('img').style.visibility = '';
    page.style.background = '';
    page.querySelector('.ocr-layer').style.visibility = '';
    page.querySelector('.ocr-layer').style.background = '';
  })()`);
  await sleep(250);
  await shoot(path.join(OUT, `p${tag}-both.png`));

  manifest.push({ tag, page: p.index + 1, lines: p.lines, rect });
  console.log(`  page ${p.index + 1}: ${p.lines} lines, rect ${Math.round(rect.w)}x${Math.round(rect.h)}`);
}

fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ dsf: DSF, pages: manifest }, null, 2));
console.log(`\n${manifest.length} pages captured in ${OUT}`);
chrome.kill();
process.exit(0);
