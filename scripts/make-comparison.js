/**
 * Build side-by-side comparison images of the OCR overlay.
 *
 * For every page with OCR text this renders three panels of the SAME
 * region:
 *
 *   1. the artwork on its own
 *   2. the overlay text on its own, on a flat background
 *   3. the artwork with the overlay text drawn on top
 *
 * The overlay is rasterised by asking the browser to draw the DOM's
 * characters into a canvas, so what is shown is what the reader draws.
 *
 * Usage:
 *   node scripts/make-comparison.js [volume-id] [out-dir]
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
const OUT = process.argv[3] || path.join(REPO, "shots");

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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=9390", `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--hide-scrollbars",
  "--force-device-scale-factor=2", "--window-size=900,1400", "about:blank",
], { stdio: "ignore" });

let wsUrl;
for (let i = 0; i < 60; i++) {
  try {
    const j = await (await fetch("http://127.0.0.1:9390/json/version")).json();
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
  { width: 900, height: 1400, deviceScaleFactor: 2, mobile: false }, sessionId);

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
    p.scrollIntoView({block:'start'});
    await new Promise(r => setTimeout(r, 700));
    const img = p.querySelector('img');
    if (!img.complete || !img.naturalWidth) continue;
    const lines = p.querySelectorAll('.ocr-line.placed').length;
    if (!lines) continue;
    out.push({ index: i, lines, file: img.src.split('/').pop() });
  }
  return out;
})()`);
console.log("pages with OCR:", pages.map((p) => p.index + 1).join(", "));

for (const p of pages) {
  const dataUrl = await ev(`(async () => {
    const page = document.querySelectorAll('.page')[${p.index}];
    const img = page.querySelector('img');
    const layer = page.querySelector('.ocr-layer');

    // The artwork's own pixel size, capped so the panels stay readable.
    const maxW = 520;
    const scale = Math.min(1, maxW / img.naturalWidth);
    const W = Math.round(img.naturalWidth * scale);
    const H = Math.round(img.naturalHeight * scale);

    const art = document.createElement('canvas');
    art.width = W; art.height = H;
    art.getContext('2d').drawImage(img, 0, 0, W, H);

    // The overlay ALONE: white text on black, so it is legible and the
    // glyph shapes and spacing can be judged.
    const ov = document.createElement('canvas');
    ov.width = W; ov.height = H;
    const octx = ov.getContext('2d');
    octx.fillStyle = '#0d0d12';
    octx.fillRect(0, 0, W, H);

    const pr = page.getBoundingClientRect();
    const dispScale = W / img.naturalWidth;

    for (const box of layer.querySelectorAll('.ocr-box')) {
      const cs = getComputedStyle(box);
      const fontSize = parseFloat(getComputedStyle(box.querySelector('.ocr-char') || box).fontSize);
      for (const line of box.querySelectorAll('.ocr-line.placed')) {
        const lcs = getComputedStyle(line);
        const lf = parseFloat(lcs.fontSize) || fontSize;
        // The line's own transform carries the condense.
        const m = new DOMMatrixReadOnly(lcs.transform);
        const chars = Array.from(line.querySelectorAll('.ocr-char'));
        if (!chars.length) continue;

        const r0 = chars[0].getBoundingClientRect();
        const x = (r0.left - pr.left) * dispScale;
        const y = (r0.top - pr.top) * dispScale;

        octx.save();
        octx.translate(x, y);
        // Apply the line's scale the same way the DOM does.
        octx.transform(m.a, m.b, m.c, m.d, 0, 0);
        octx.font = lf + 'px ' + cs.fontFamily;
        octx.textBaseline = 'alphabetic';
        octx.fillStyle = '#ffffff';
        octx.fillText(line.textContent, 0, lf * 0.82);
        octx.restore();
      }
    }

    // Artwork + overlay.
    const both = document.createElement('canvas');
    both.width = W; both.height = H;
    const bctx = both.getContext('2d');
    bctx.drawImage(art, 0, 0);
    bctx.drawImage(ov, 0, 0);

    const PAD = 12, LABEL = 20;
    const out = document.createElement('canvas');
    out.width = W * 3 + PAD * 4;
    out.height = H + LABEL + PAD * 2;
    const c = out.getContext('2d');
    c.fillStyle = '#16161c';
    c.fillRect(0, 0, out.width, out.height);
    const put = (canvas, x, label) => {
      c.fillStyle = '#e8e8ee';
      c.font = 'bold 12px system-ui, sans-serif';
      c.fillText(label, x, 14);
      c.drawImage(canvas, x, LABEL);
      c.strokeStyle = '#3a3a44';
      c.strokeRect(x, LABEL, W, H);
    };
    put(art, PAD, '1. artwork');
    put(ov, PAD * 2 + W, '2. overlay text alone');
    put(both, PAD * 3 + W * 2, '3. artwork + overlay');
    return out.toDataURL('image/png');
  })()`);

  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
    console.log(`  page ${p.index}: ${String(dataUrl).slice(0, 120)}`);
    continue;
  }
  const file = path.join(OUT, `compare-${String(p.index + 1).padStart(2, "0")}.png`);
  fs.writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(`  page ${p.index + 1} (${p.lines} lines) -> ${file}`);
}

chrome.kill();
process.exit(0);
