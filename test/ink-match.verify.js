// Verify the overlay against the artwork's real lettering.
//
// The ground truth is the artwork's ink, measured with the same routine
// the reader uses (public/ink.js). For every rendered line this checks:
//
//   SIZE      the overlay's glyph ink height vs the artwork's
//   POSITION  the overlay's text origin vs the artwork's lettering
//   FIT       the overlay's text stays inside the artwork's lettering
//   OVERLAP   no two characters overlap
//
// Run: node test/ink-match.verify.js

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
  console.log(`volume "${vol.title}"`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-ink-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9372",
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9372/json/version")).json();
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
  await sleep(2500);
  await ev("window.setOcrMode('read')");
  await sleep(2500);

  const data = await ev(`(() => {
    const out = [];
    for (const wrap of document.querySelectorAll('.page')) {
      const img = wrap.querySelector('img');
      if (!img || !img.naturalWidth) continue;
      const ir = img.getBoundingClientRect();
      const scale = ir.width / img.naturalWidth;

      for (const l of wrap.querySelectorAll('.ocr-line.placed')) {
        const chars = Array.from(l.querySelectorAll('.ocr-char'));
        if (!chars.length) continue;
        const crs = chars.map(c => c.getBoundingClientRect());
        const cs = getComputedStyle(chars[0]);
        const lr = l.getBoundingClientRect();

        // The overlay's INK box — the glyphs themselves, not their em
        // boxes. The em box is taller than the ink (it carries the
        // ascent and descent), so comparing em boxes to the artwork's
        // ink would overstate the overlay by the same factor every
        // time.
        //
        // The ink ratio is measured from the font with the SAME routine
        // the app uses, so the comparison is exact.
        const fontMetrics = window.MANGA_INK.measureFontMetrics(cs.fontFamily);
        const fx0 = Math.min(...crs.map(r => r.left));
        const fy0 = Math.min(...crs.map(r => r.top));
        const fx1 = Math.max(...crs.map(r => r.right));
        const fy1 = Math.max(...crs.map(r => r.bottom));

        // The artwork's lettering, in display pixels.
        const blk = Number(l.closest('.ocr-box').dataset.ocrBlock);
        const li = Number(l.dataset.ocrLine);
        const page = window.state.ocrData.pages.find(p => p.img_path && p.img_path.endsWith(wrap.dataset.file));
        const b = page && page.blocks[blk];
        let art = null;
        if (b) {
          const m = window.MANGA_INK.measureInk(img, b.lines_coords[li], !!b.vertical);
          if (m) {
            const q = b.lines_coords[li];
            const xs = q.map(p=>p[0]), ys = q.map(p=>p[1]);
            const qx0 = Math.min(...xs), qy0 = Math.min(...ys);
            art = {
              // VIEWPORT coordinates: the image's display origin plus
              // the lettering's offset within it.
              x: ir.left + (qx0 + m.offset.x) * scale,
              y: ir.top + (qy0 + m.offset.y) * scale,
              cross: m.crossExtent * scale,
              along: m.alongExtent * scale,
            };
          }
        }

        // Overlapping characters?
        let overlaps = 0;
        for (let i = 1; i < crs.length; i++) {
          if (crs[i].left < crs[i-1].right - 0.6) overlaps++;
        }

        out.push({
          text: l.textContent.slice(0, 14),
          vertical: l.closest('.ocr-box').classList.contains('vertical'),
          n: chars.length,
          fontSize: parseFloat(cs.fontSize),
          // The overlay's INK extent, in em. Multiply by the font size
          // to get the ink's size in display pixels.
          ovInk: fontMetrics,
          // The overlay's rendered box, in viewport px.
          ov: { x: fx0, y: fy0, w: fx1-fx0, h: fy1-fy0 },
          art,
          overlaps,
          boxW: lr.width,
          contentW: crs[crs.length-1].right - crs[0].left,
        });
      }
    }
    return out;
  })()`);

  console.log(`  ${data.length} rendered lines`);

  // ── SIZE: the overlay's glyph ink height vs the artwork's ────
  // The overlay's ink height is the font size times the browser's ink
  // ratio (measured per line), times the condense for the cross axis
  // (which is 1 — only the along axis is condensed).
  const sizeRatios = [];
  const posErrs = [];
  for (const d of data) {
    if (!d.art || !d.ovInk) continue;
    // For vertical text the cross axis is the glyph's WIDTH; for
    // horizontal text it is its HEIGHT.
    const ovCross = d.vertical
      ? d.fontSize * d.ovInk.inkWidth
      : d.fontSize * d.ovInk.inkHeight;
    sizeRatios.push({ text: d.text, r: ovCross / d.art.cross });
    posErrs.push({ text: d.text, dx: d.ov.x - d.art.x, dy: d.ov.y - d.art.y });
  }

  const ratios = sizeRatios.map(s => s.r).filter(r => isFinite(r) && r > 0);
  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const med = ratios.slice().sort((a, b) => a - b)[ratios.length >> 1];
  console.log(`  overlay/artwork size ratio — median ${med.toFixed(3)}, mean ${avg.toFixed(3)}`);

  if (process.env.INK_DEBUG) {
    console.log("  DEBUG:");
    for (const d of data.slice(0, 8)) {
      console.log(`    "${d.text}" fs=${d.fontSize} ovInk=${JSON.stringify(d.ovInk)} art=${JSON.stringify(d.art)}`);
    }
  }

  check("the overlay's glyphs are the same size as the artwork's",
    med > 0.75 && med < 1.35,
    `median ratio ${med.toFixed(3)} (want 0.75-1.35)`);

  // ── POSITION: the overlay's text origin vs the artwork's ────
  const dx = posErrs.map(p => Math.abs(p.dx));
  const dy = posErrs.map(p => Math.abs(p.dy));
  const medDx = dx.sort((a, b) => a - b)[dx.length >> 1];
  const medDy = dy.sort((a, b) => a - b)[dy.length >> 1];
  console.log(`  position error — median |dx| ${medDx.toFixed(1)}px, |dy| ${medDy.toFixed(1)}px`);

  check("the overlay's text starts at the artwork's lettering",
    medDx <= 12 && medDy <= 12,
    `median |dx| ${medDx.toFixed(1)}px |dy| ${medDy.toFixed(1)}px (want <= 12px)`);

  // ── OVERLAP ─────────────────────────────────────────────────
  const overlaps = data.filter(d => d.overlaps > 0);
  check("no characters overlap",
    overlaps.length === 0,
    `${overlaps.length} lines with overlaps: ${overlaps.slice(0, 3).map(o => `"${o.text}" (${o.overlaps})`).join(", ")}`);

  // ── FIT: the overlay's text stays inside the artwork's lettering ──
  // A few pixels of tolerance: the artwork's lettering is hand-drawn,
  // so its measured extent is itself approximate.
  let bleeds = 0;
  const bleedList = [];
  for (const d of data) {
    if (!d.art) continue;
    // The overlay's along-axis extent must not exceed the artwork's.
    const over = d.vertical
      ? d.ov.h - d.art.along
      : d.ov.w - d.art.along;
    const tol = Math.max(8, d.art.along * 0.05);
    if (over > tol) {
      bleeds++;
      bleedList.push(`${d.text}: ${d.ov.w.toFixed(0)} > ${d.art.along.toFixed(0)}`);
    }
  }
  check("the overlay's text stays inside the artwork's lettering",
    bleeds === 0,
    `${bleeds} lines spill: ${bleedList.slice(0, 3).join(", ")}`);

  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  chrome.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
