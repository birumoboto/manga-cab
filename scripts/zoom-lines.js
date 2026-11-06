/**
 * Capture ZOOMED crops around each OCR line, so the typography can be
 * judged at a readable size.
 *
 * For every OCR line it takes two viewport screenshots of the same
 * region, scaled up:
 *
 *   -NN-line.png   the artwork with the overlay on
 *   -NN-zoom.png   the same region with the artwork's lettering and the
 *                  overlay's lettering side by side, magnified
 *
 * The crop is the line's own box, expanded to include the artwork's
 * ink around it, so the comparison is exactly the region the reader
 * draws into.
 *
 * Usage:
 *   node scripts/zoom-lines.js [volume-id] [out-dir]
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
const OUT = process.argv[3] || path.join(REPO, "shots", "zoom");
const DSF = 2;

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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "zoom-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=9392", `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--hide-scrollbars",
  `--force-device-scale-factor=${DSF}`, "--window-size=820,1200", "about:blank",
], { stdio: "ignore" });

let wsUrl;
for (let i = 0; i < 60; i++) {
  try {
    const j = await (await fetch("http://127.0.0.1:9392/json/version")).json();
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

// Collect every OCR line with its on-screen rect.
const lines = await ev(`(async () => {
  const out = [];
  const ps = Array.from(document.querySelectorAll('.page'));
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const img = p.querySelector('img');
    if (!img.complete || !img.naturalWidth) continue;
    const ls = p.querySelectorAll('.ocr-line.placed');
    if (!ls.length) continue;
    const pr = p.getBoundingClientRect();
    const rr = document.querySelector('.reader').getBoundingClientRect();
    for (const l of ls) {
      const r = l.getBoundingClientRect();
      out.push({
        page: i,
        text: l.textContent,
        vertical: l.closest('.ocr-box').classList.contains('vertical'),
        // Where the line sits inside the page image, in fractions.
        rel: {
          x: (r.left - pr.left) / pr.width,
          y: (r.top - pr.top) / pr.height,
          w: r.width / pr.width,
          h: r.height / pr.height,
        },
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      });
    }
  }
  return out;
})()`);
console.log("OCR lines:", lines.length);

const shoot = async (file, clip) => {
  const { data } = await cdp.send("Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false, clip: { ...clip, scale: 3 } }, sessionId);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
};

const manifest = [];
for (const [i, l] of lines.entries()) {
  const tag = `l${String(i + 1).padStart(2, "0")}`;

  // Scroll the page so the line is on screen.
  await ev(`(() => {
    const page = document.querySelectorAll('.page')[${l.page}];
    const reader = document.querySelector('.reader');
    const pr = page.getBoundingClientRect();
    const rr = reader.getBoundingClientRect();
    reader.scrollTop += (pr.top - rr.top);
    return 1;
  })()`);
  await sleep(800);

  // The clip: the line's box, expanded so the artwork's lettering around
  // it is visible, and kept inside the viewport.
  const clip = await ev(`(() => {
    const page = document.querySelectorAll('.page')[${l.page}];
    const img = page.querySelector('img');
    const pr = page.getBoundingClientRect();
    const rr = document.querySelector('.reader').getBoundingClientRect();
    const x = pr.left + ${l.rel.x} * pr.width;
    const y = pr.top + ${l.rel.y} * pr.height;
    const w = ${l.rel.w} * pr.width;
    const h = ${l.rel.h} * pr.height;
    const padX = Math.max(30, w * 0.12);
    const padY = Math.max(24, h * 0.55);
    const cx = Math.max(rr.left + 4, x - padX);
    const cy = Math.max(rr.top + 4, y - padY);
    const cw = Math.min(rr.right - 4 - cx, w + padX * 2);
    const ch = Math.min(rr.bottom - 4 - cy, h + padY * 2);
    return { x: cx, y: cy, width: cw, height: ch };
  })()`);
  if (!clip || clip.width < 20 || clip.height < 20) {
    console.log(`  ${tag}: clip failed`);
    continue;
  }

  // artwork + overlay
  await shoot(path.join(OUT, `${tag}-both.png`), clip);

  // artwork only
  await ev(`document.querySelectorAll('.page')[${l.page}].querySelector('.ocr-layer').style.visibility='hidden'`);
  await sleep(220);
  await shoot(path.join(OUT, `${tag}-art.png`), clip);
  await ev(`document.querySelectorAll('.page')[${l.page}].querySelector('.ocr-layer').style.visibility=''`);
  await sleep(150);

  // overlay only, on black
  await ev(`(() => {
    const page = document.querySelectorAll('.page')[${l.page}];
    page.querySelector('img').style.visibility = 'hidden';
    page.style.background = '#000';
    page.querySelector('.ocr-layer').style.visibility = '';
    page.querySelector('.ocr-layer').style.background = '#000';
  })()`);
  await sleep(220);
  await shoot(path.join(OUT, `${tag}-ov.png`), clip);
  await ev(`(() => {
    const page = document.querySelectorAll('.page')[${l.page}];
    page.querySelector('img').style.visibility = '';
    page.style.background = '';
    page.querySelector('.ocr-layer').style.background = '';
  })()`);

  manifest.push({ tag, ...l, clip });
  console.log(`  ${tag}: p${l.page + 1} ${l.vertical ? "VERT" : "horz"} ${JSON.stringify(l.text.slice(0, 24))}`);
}

fs.writeFileSync(path.join(OUT, "manifest.json"),
  JSON.stringify({ dsf: DSF, lines: manifest }, null, 2));
console.log(`\n${manifest.length} line crops in ${OUT}`);
chrome.kill();
process.exit(0);
