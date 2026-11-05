// Measures whether the OCR overlay text is the SAME SIZE as the
// artwork text underneath it.
//
// The way to check: pick a text block, find where the overlay's glyphs
// actually render, and compare that height against the height of the
// same region in the source image (scaled to its displayed size).
//
// A mismatch means the selectable text does not line up with the
// lettering in the artwork — which is what "scale the text size to be
// similar to the image text" is asking for.
//
// Run: node test/text-scale.verify.js

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-scale-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9341",
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });

  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9341/json/version")).json();
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

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 412, height: 915, deviceScaleFactor: 2, mobile: true,
  }, sessionId);
  await cdp.send("Page.navigate", { url: BASE }, sessionId);
  await sleep(2500);

  const ev = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return "ERR " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // Build a volume with a known image size so the arithmetic is checkable.
  const setup = await ev(`(async () => {
    const mkCanvas = (w, h, text) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0,0,w,h);
      g.fillStyle = '#000'; g.font = '60px sans-serif';
      g.fillText(text, 40, 120);
      return c;
    };
    const c = mkCanvas(1200, 800, '测试文字');
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const fd = new FormData();
    fd.append('files', blob, 'p001.png');
    fd.append('title', 'Scale Test');
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!data.volume) return 'ERR ' + JSON.stringify(data);
    const v = data.volume;

    // font_size 60 in a 1200px-wide image
    const doc = { pages: [{ img_path: '001.png', img_width: 1200, img_height: 800,
      blocks: [{ box: [40, 60, 400, 130], font_size: 60, vertical: false, lines: ['测试文字'] }] }] };
    await window.attachMokuro(v.id, new File([JSON.stringify(doc)], 'v.mokuro', {type:'application/json'}));
    await window.openVolume(v.id);
    await new Promise(r2 => setTimeout(r2, 1200));
    window.setOcr(true);
    await new Promise(r2 => setTimeout(r2, 800));
    return v.id;
  })()`);
  check("scale-test volume ready", typeof setup === "string" && setup.startsWith("mw"), String(setup));
  if (typeof setup !== "string" || !setup.startsWith("mw")) {
    chrome.kill();
    process.exit(1);
  }

  // ── Measure at a phone width ────────────────────────────────
  const measure = async (vw, vh, label) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: vw, height: vh, deviceScaleFactor: 2, mobile: true,
    }, sessionId);
    await sleep(700);

    return await ev(`(() => {
      const img = document.querySelector('.page img');
      const box = document.querySelector('.ocr-box');
      const layer = document.querySelector('.ocr-layer');
      if (!img || !box || !layer) return null;

      const ir = img.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      const lr = layer.getBoundingClientRect();

      // The rendered height of the overlay glyphs: use a Range over the
      // text node so we measure the line box, not the container.
      const range = document.createRange();
      range.selectNodeContents(box);
      const rects = Array.from(range.getClientRects());
      const textH = rects.length ? Math.min(...rects.map(r => r.height)) : 0;

      // The expected size: font_size scaled by the image display ratio.
      const scale = ir.width / 1200;
      const expected = 60 * scale;

      // Where the artwork's own lettering sits: the block box in image
      // px, scaled to display px.
      const artH = (130 - 60) * scale;

      return {
        vw: window.innerWidth,
        imgW: Math.round(ir.width), imgLeft: Math.round(ir.left),
        layerW: Math.round(lr.width), layerLeft: Math.round(lr.left),
        boxLeft: Math.round(br.left), boxTop: Math.round(br.top),
        boxW: Math.round(br.width), boxH: Math.round(br.height),
        textH: Math.round(textH * 10) / 10,
        scale: Math.round(scale * 1000) / 1000,
        expected: Math.round(expected * 10) / 10,
        artH: Math.round(artH * 10) / 10,
        fontSize: getComputedStyle(box).fontSize,
        ocrSize: box.style.getPropertyValue('--ocr-size'),
      };
    })()`);
  };

  console.log("");
  console.log("── overlay text size vs artwork ──");

  const phone = await measure(412, 915, "phone");
  console.log("  phone  :", JSON.stringify(phone));
  check("overlay is scaled with the image", phone && phone.scale > 0 && phone.scale < 1, `scale=${phone?.scale}`);
  if (phone) {
    // The rendered glyph height should be within 25% of the artwork's.
    const ratio = phone.textH / phone.artH;
    check("overlay text height matches the artwork text height",
      ratio > 0.75 && ratio < 1.35,
      `overlay=${phone.textH}px artwork=${phone.artH}px ratio=${ratio.toFixed(2)}`);
  }

  const desktop = await measure(1200, 900, "desktop");
  console.log("  desktop:", JSON.stringify(desktop));
  if (desktop) {
    const ratio = desktop.textH / desktop.artH;
    check("overlay text height matches the artwork on desktop too",
      ratio > 0.75 && ratio < 1.35,
      `overlay=${desktop.textH}px artwork=${desktop.artH}px ratio=${ratio.toFixed(2)}`);
    // The overlay LAYER must match the image exactly: same width, same
    // left edge. (The text box inside it is only as wide as its text.)
    check("overlay layer tracks the image width",
      Math.abs(desktop.layerW - desktop.imgW) <= 2,
      `layer=${desktop.layerW}px image=${desktop.imgW}px`);
    check("overlay layer is aligned with the image",
      Math.abs(desktop.layerLeft - desktop.imgLeft) <= 2,
      `layer left=${desktop.layerLeft} image left=${desktop.imgLeft}`);
  }

  const narrow = await measure(360, 740, "small");
  console.log("  small  :", JSON.stringify(narrow));
  if (narrow) {
    const ratio = narrow.textH / narrow.artH;
    check("overlay text height matches the artwork on a small phone",
      ratio > 0.75 && ratio < 1.35,
      `overlay=${narrow.textH}px artwork=${narrow.artH}px ratio=${ratio.toFixed(2)}`);
  }

  // Clean up
  await fetch(`${BASE}/api/volumes/${setup}`, { method: "DELETE" });

  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  chrome.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
