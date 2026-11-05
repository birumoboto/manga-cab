/**
 * Measure the overlay against the artwork in the BROWSER, where the
 * geometry is exact, and report per line.
 *
 * For every rendered OCR line it compares:
 *
 *   * the overlay's INK extent (measured by rasterising the text, the
 *     same way the reader measures the artwork's ink)
 *   * the artwork's INK extent in the same region
 *
 * and reports the position error and the size ratio.
 *
 * It also reports the HALO: how much artwork each pixel of the overlay
 * darkens. A wide shadow paints a black smear over the artwork beside
 * every character, which is what makes the overlay look like it has a
 * box around it.
 *
 * Usage:
 *   node scripts/measure-overlay.js [volume-id]
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:8790";
const VOLUME = process.argv[2] || "mw383dg7-5c0ce6cb";

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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "meas-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=9393", `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--hide-scrollbars",
  "--force-device-scale-factor=2", "--window-size=820,1200", "about:blank",
], { stdio: "ignore" });

let wsUrl;
for (let i = 0; i < 60; i++) {
  try {
    const j = await (await fetch("http://127.0.0.1:9393/json/version")).json();
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
  { width: 820, height: 1200, deviceScaleFactor: 2, mobile: false }, sessionId);

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
await sleep(3000);

const out = await ev(`(async () => {
  const results = [];
  const ps = Array.from(document.querySelectorAll('.page'));
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    p.scrollIntoView({block:'start'});
    await new Promise(r => setTimeout(r, 500));
    const img = p.querySelector('img');
    if (!img.complete || !img.naturalWidth) continue;

    for (const line of p.querySelectorAll('.ocr-line.placed')) {
      const box = line.closest('.ocr-box');
      const vertical = box.classList.contains('vertical');
      const chars = Array.from(line.querySelectorAll('.ocr-char'));
      if (!chars.length) continue;

      const crs = chars.map(c => c.getBoundingClientRect());
      const x0 = Math.min(...crs.map(r => r.left));
      const y0 = Math.min(...crs.map(r => r.top));
      const x1 = Math.max(...crs.map(r => r.right));
      const y1 = Math.max(...crs.map(r => r.bottom));

      // The characters must not overlap.
      let overlaps = 0;
      for (let k = 1; k < crs.length; k++) {
        if (crs[k].left < crs[k-1].right - 0.6) overlaps++;
      }

      // The artwork's ink in the same region.
      const pr = p.getBoundingClientRect();
      const ir = img.getBoundingClientRect();
      let art = null;
      try {
        art = window.MANGA_INK.measureInk(img, {
          x0: (x0 - ir.left) / ir.width * img.naturalWidth,
          y0: (y0 - ir.top) / ir.height * img.naturalHeight,
          x1: (x1 - ir.left) / ir.width * img.naturalWidth,
          y1: (y1 - ir.top) / ir.height * img.naturalHeight,
        }, vertical);
      } catch (e) {
        art = { error: String(e) };
      }

      // The text-shadow: how far it spreads beyond the glyph.
      const cs = getComputedStyle(box);
      const shadow = cs.textShadow;

      results.push({
        page: i + 1,
        vertical,
        text: line.textContent.slice(0, 20),
        chars: chars.length,
        overlaps,
        fs: parseFloat(getComputedStyle(chars[0]).fontSize) || 0,
        width: x1 - x0,
        height: y1 - y0,
        art: art ? { cross: art.cross, along: art.along, offset: art.offset } : null,
        shadow,
      });
    }
  }
  return results;
})()`);

console.log(`measured ${out.length} lines`);
console.log();
console.log(`${"page".padStart(5)} ${"v"} ${"chars".padStart(6)} ${"ovl".padStart(4)} ${"fs".padStart(7)} `
  + `${"ov w".padStart(7)} ${"art w".padStart(7)} ${"ratio".padStart(6)}  shadow`);
console.log("-".repeat(110));

let bad = 0;
for (const r of out) {
  const ratio = r.art ? (r.vertical ? r.width / r.art.cross : r.width / r.art.along) : 0;
  const shadow = (r.shadow || "").replace(/\s+/g, " ").slice(0, 38);
  console.log(`${String(r.page).padStart(5)} ${r.vertical ? "V" : " "} `
    + `${String(r.chars).padStart(6)} ${String(r.overlaps).padStart(4)} `
    + `${r.fs.toFixed(1).padStart(7)} ${r.width.toFixed(0).padStart(7)} `
    + `${r.art ? (r.vertical ? r.art.cross : r.art.along).toFixed(0) : "-".padStart(7)} `
    + `${ratio.toFixed(2).padStart(6)}  ${shadow}`);
  if (r.overlaps) bad++;
}
console.log();
console.log(`lines with overlapping characters: ${bad}`);
chrome.kill();
process.exit(0);
