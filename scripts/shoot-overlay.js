/**
 * Screenshot the reader with the OCR overlay on, one image per page.
 *
 * Runs the real app in headless Chrome, loads the volume, waits for
 * every page's overlay to render (the overlay is drawn after the page
 * image decodes, because the ink can only be measured from pixels that
 * have loaded), then captures the reader viewport at each page.
 *
 * Usage:
 *   node scripts/shoot-overlay.js [volume-id] [out-dir]
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
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.on("open", res);
      ws.on("error", rej);
    });
    const c = new CDP(ws);
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && c.pending.has(m.id)) {
        const p = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const pl = { id, method, params };
    if (sessionId) pl.sessionId = sessionId;
    this.ws.send(JSON.stringify(pl));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => rej(new Error("timeout " + method)), 60000);
    });
  }
}

fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "shot-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--remote-debugging-port=9388",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    "--window-size=900,1400",
    "about:blank",
  ],
  { stdio: "ignore" }
);

let wsUrl;
for (let i = 0; i < 60; i++) {
  try {
    const j = await (await fetch("http://127.0.0.1:9388/json/version")).json();
    if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(250);
}
if (!wsUrl) { console.error("chrome did not start"); process.exit(1); }

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
  if (r.exceptionDetails) {
    return "ERR " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
};

console.log("href:", await ev("location.href"));

// Open the volume and turn the OCR layer on.
await ev(`window.openVolume(${JSON.stringify(VOLUME)})`);
await sleep(2000);
await ev(`window.setOcrMode("read")`);
await sleep(3000);

// Scroll every page into view so each one's overlay is rendered (the
// overlay is drawn when the page image decodes).
const total = await ev(`document.querySelectorAll('.page').length`);
console.log("pages:", total);

const shots = [];
for (let i = 0; i < total; i++) {
  await ev(`(() => {
    const p = document.querySelectorAll('.page')[${i}];
    p.scrollIntoView({block:'start'});
    p.querySelector('img').scrollIntoView({block:'start'});
    return 1;
  })()`);
  await sleep(1400);

  const ready = await ev(`(() => {
    const p = document.querySelectorAll('.page')[${i}];
    const img = p.querySelector('img');
    const lines = p.querySelectorAll('.ocr-line.placed').length;
    return { complete: img.complete && img.naturalWidth > 0, lines };
  })()`);
  if (!ready || !ready.complete) {
    console.log(`  page ${i}: image not ready`);
    continue;
  }

  const file = path.join(OUT, `page-${String(i + 1).padStart(2, "0")}.png`);
  const { data } = await cdp.send("Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false }, sessionId);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  shots.push({ page: i, file, lines: ready.lines });
  console.log(`  page ${i}: ${ready.lines} lines -> ${file}`);
}

// One shot with a zone revealed, so the white panel can be seen too.
await ev(`(() => {
  const z = window.MANGA_CAB.getZones();
  if (!z.length) return 0;
  const target = z.find(x => x.text && x.text.length > 6) || z[0];
  window.MANGA_CAB.revealZone(target.index);
  return 1;
})()`);
await sleep(700);
{
  const file = path.join(OUT, "zone-revealed.png");
  const { data } = await cdp.send("Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false }, sessionId);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log("zone revealed ->", file);
}

fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(shots, null, 2));
console.log(`\n${shots.length} shots in ${OUT}`);
chrome.kill();
process.exit(0);
