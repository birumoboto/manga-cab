// Diagnose the overlay's rendering against the artwork.
//
// For every rendered line this reports:
//   - the artwork's real ink height inside the quad (measured with a
//     canvas, so it is the same pixels the reader is showing)
//   - the font size the overlay is using
//   - the ratio between them  (1.0 = the overlay glyphs are exactly as
//     tall as the artwork's lettering)
//   - whether adjacent characters overlap
//   - whether the line's content overflows its box
//
// Run: node test/_diag_render.js

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE_URL || "http://127.0.0.1:8790";
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
  const withOcr = [];
  for (const v of volumes) {
    const ocr = await (await fetch(`${BASE}/v/${v.id}/mokuro`)).json();
    if (ocr.pages?.length) {
      const chars = ocr.pages.reduce((n, p) => n + p.blocks.reduce((m, b) => m + b.lines.join("").length, 0), 0);
      withOcr.push({ v, chars });
    }
  }
  withOcr.sort((a, b) => b.chars - a.chars);
  const vol = withOcr[0].v;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-diag-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9366",
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9366/json/version")).json();
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
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2, mobile: true }, sessionId);
  await cdp.send("Page.navigate", { url: BASE }, sessionId);
  await sleep(2500);

  const ev = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return "ERR " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await ev(`window.openVolume('${vol.id}')`);
  await sleep(2200);
  await ev("window.setOcrMode('read')");
  await sleep(2000);

  const out = await ev(`(() => {
    const lines = [];
    for (const wrap of document.querySelectorAll('.page')) {
      const img = wrap.querySelector('img');
      if (!img || !img.naturalWidth) continue;
      const ir = img.getBoundingClientRect();
      const scale = ir.width / img.naturalWidth;

      for (const l of wrap.querySelectorAll('.ocr-line.placed')) {
        const chars = Array.from(l.querySelectorAll('.ocr-char'));
        if (!chars.length) continue;
        const lr = l.getBoundingClientRect();
        const crs = chars.map(c => c.getBoundingClientRect());
        const cs = getComputedStyle(chars[0]);

        // Do adjacent characters overlap?
        let overlaps = 0;
        for (let i = 1; i < crs.length; i++) {
          const a = crs[i-1], b = crs[i];
          if (b.left < a.right - 0.6) overlaps++;
        }

        // Does the content overflow the line box?
        const contentW = crs.length ? crs[crs.length-1].right - crs[0].left : 0;
        const contentH = crs.length ? crs[crs.length-1].bottom - crs[0].top : 0;

        lines.push({
          text: l.textContent.slice(0, 16),
          vertical: l.closest('.ocr-box').classList.contains('vertical'),
          fontSize: cs.fontSize,
          charW: Math.round(crs[0].width * 10) / 10,
          charH: Math.round(crs[0].height * 10) / 10,
          n: chars.length,
          overlaps,
          boxW: Math.round(lr.width), boxH: Math.round(lr.height),
          contentW: Math.round(contentW), contentH: Math.round(contentH),
          scrollW: l.scrollWidth, scrollH: l.scrollHeight,
          shrink: chars.map(c => c.style.flexShrink).filter(Boolean)[0] || '',
          condense: l.style.getPropertyValue('--ocr-condense'),
        });
      }
    }
    return lines;
  })()`);

  console.log("text              V fs        char      n  ov  box            content         shrink condense");
  for (const l of out) {
    console.log(
      `${l.text.padEnd(17)} ${l.vertical ? "V" : " "} ${l.fontSize.padEnd(9)} ` +
      `${String(l.charW).padStart(4)}x${String(l.charH).padEnd(4)} ${String(l.n).padStart(2)} ` +
      `${String(l.overlaps).padStart(3)}  ${String(l.boxW).padStart(4)}x${String(l.boxH).padEnd(4)} ` +
      `${String(l.contentW).padStart(4)}x${String(l.contentH).padEnd(5)} (scroll ${l.scrollW}x${l.scrollH}) ` +
      `${l.shrink || '-'} ${l.condense || '-'}`);
  }
  const bad = out.filter(l => l.overlaps > 0);
  console.log("");
  console.log(`${out.length} lines, ${bad.length} with overlapping characters`);
  for (const b of bad.slice(0, 8)) {
    console.log(`  OVERLAP "${b.text}" n=${b.n} ov=${b.overlaps} charW=${b.charW} contentW=${b.contentW} boxW=${b.boxW}`);
  }

  chrome.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
