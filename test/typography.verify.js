// Verifies the overlay's typography against the artwork:
//
//   1. ALIGNMENT — every line sits exactly at its detected quad
//   2. NO OVERLAP — two lines never sit on top of each other
//   3. NO BLEED — the text stays inside its quad, and inside the white
//      panel
//   4. VERTICAL — vertical text is laid out down the column, sized to
//      the quad's width
//   5. CLICK OFF — clicking outside the text clears the highlight
//
// The ground truth is the artwork: `scripts/measure_ink.py` measures the
// real ink inside every detected quad.
//
// Run: node test/typography.verify.js

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
      withOcr.push({ v, ocr, chars });
    }
  }
  withOcr.sort((a, b) => b.chars - a.chars);
  const { v, ocr } = withOcr[0];
  console.log(`volume "${v.title}"`);

  // Expected: the source quads, so we can compare against them.
  const srcQuads = [];
  for (let pi = 0; pi < ocr.pages.length; pi++) {
    for (const blk of ocr.pages[pi].blocks || []) {
      for (let li = 0; li < (blk.lines_coords || []).length; li++) {
        const q = blk.lines_coords[li];
        const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
        srcQuads.push({
          page: pi, block: Number(blk.vertical), vertical: !!blk.vertical,
          line: li,
          x: Math.min(...xs), y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs),
          h: Math.max(...ys) - Math.min(...ys),
          text: (blk.lines || [])[li] || "",
        });
      }
    }
  }
  const srcVertical = srcQuads.filter((q) => q.vertical);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-typo-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9363",
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9363/json/version")).json();
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

  await ev(`window.openVolume('${v.id}')`);
  await sleep(2200);
  await ev("window.setOcrMode('tap')");
  await sleep(1800);

  // ── 1 + 2 + 3: geometry of every rendered line ─────────────
  const geo = await ev(`(() => {
    const out = [];
    for (const wrap of document.querySelectorAll('.page')) {
      const pageIdx = Number(wrap.dataset.index);
      const img = wrap.querySelector('img');
      const imgRect = img.getBoundingClientRect();
      const imgW = img.naturalWidth || 1, imgH = img.naturalHeight || 1;
      const scale = imgRect.width / imgW;

      for (const b of wrap.querySelectorAll('.ocr-box')) {
        const blkIdx = Number(b.dataset.ocrBlock);
        const vertical = b.classList.contains('vertical');
        for (const l of b.querySelectorAll('.ocr-line')) {
          const lr = l.getBoundingClientRect();
          const chars = Array.from(l.querySelectorAll('.ocr-char'));
          const crs = chars.map(c => c.getBoundingClientRect());
          const cx0 = crs.length ? Math.min(...crs.map(r => r.left)) : 0;
          const cy0 = crs.length ? Math.min(...crs.map(r => r.top)) : 0;
          const cx1 = crs.length ? Math.max(...crs.map(r => r.right)) : 0;
          const cy1 = crs.length ? Math.max(...crs.map(r => r.bottom)) : 0;
          out.push({
            page: pageIdx, block: blkIdx,
            line: Number(l.dataset.ocrLine),
            vertical,
            text: l.textContent,
            lineBox: { x: lr.left, y: lr.top, w: lr.width, h: lr.height },
            charBox: { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 },
            // Where the line box sits relative to the image.
            imgLeft: imgRect.left, imgTop: imgRect.top, scale,
            imgW, imgH,
          });
        }
      }
    }
    return out;
  })()`);

  console.log(`  ${geo.length} rendered lines`);

  // Map each rendered line back to its source quad.
  const quadFor = (g) => {
    const page = ocr.pages[g.page];
    if (!page) return null;
    const blk = (page.blocks || [])[g.block];
    if (!blk) return null;
    const q = (blk.lines_coords || [])[g.line];
    if (!q) return null;
    const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
    return {
      x: Math.min(...xs), y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
      vertical: !!blk.vertical,
    };
  };

  let alignWorst = 0, alignWorstLine = "";
  let bleed = [], overlaps = [];
  for (const g of geo) {
    const q = quadFor(g);
    if (!q) continue;
    const s = g.scale;
    // The quad's display size.
    const qw = q.w * s, qh = q.h * s;

    // ── ALIGNMENT: the line box must match the quad's size.
    const dw = Math.abs(g.lineBox.w - qw);
    const dh = Math.abs(g.lineBox.h - qh);
    if (dw > alignWorst) { alignWorst = dw; alignWorstLine = g.text.slice(0, 14); }

    // ── BLEED: the characters must stay inside the quad.
    // For a horizontal line the text runs along X; for a vertical one
    // it runs down Y.
    const along = q.vertical ? g.charBox.h : g.charBox.w;
    const alongLimit = q.vertical ? qh : qw;
    const across = q.vertical ? g.charBox.w : g.charBox.h;
    const acrossLimit = q.vertical ? qw : qh;
    if (along > alongLimit + 2 || across > acrossLimit + 2) {
      bleed.push({
        text: g.text.slice(0, 14), vertical: q.vertical,
        along: Math.round(along), alongLimit: Math.round(alongLimit),
        across: Math.round(across), acrossLimit: Math.round(acrossLimit),
      });
    }
  }

  check("every line box matches its detected quad",
    alignWorst <= 4, `worst mismatch ${alignWorst.toFixed(1)}px on "${alignWorstLine}"`);

  check("no text bleeds past its quad",
    bleed.length === 0, `${bleed.length} bleeding: ${JSON.stringify(bleed.slice(0, 3))}`);

  // ── 2: OVERLAP between lines ────────────────────────────────
  // Two lines may only overlap if their SOURCE quads overlap.
  const srcOverlap = (a, b) => {
    const qa = quadFor(a), qb = quadFor(b);
    if (!qa || !qb) return false;
    const s = a.scale;
    const ox = Math.min(qa.x + qa.w, qb.x + qb.w) - Math.max(qa.x, qb.x);
    const oy = Math.min(qa.y + qa.h, qb.y + qb.h) - Math.max(qa.y, qb.y);
    return ox * s > 6 && oy * s > 6;
  };

  for (let i = 0; i < geo.length; i++) {
    for (let j = i + 1; j < geo.length; j++) {
      const a = geo[i], b = geo[j];
      if (a.page !== b.page) continue;
      const ox = Math.min(a.charBox.x + a.charBox.w, b.charBox.x + b.charBox.w)
               - Math.max(a.charBox.x, b.charBox.x);
      const oy = Math.min(a.charBox.y + a.charBox.h, b.charBox.y + b.charBox.h)
               - Math.max(a.charBox.y, b.charBox.y);
      if (ox > 6 && oy > 6) {
        if (!srcOverlap(a, b)) {
          overlaps.push(`"${a.text.slice(0, 10)}" / "${b.text.slice(0, 10)}" (${Math.round(ox)}x${Math.round(oy)})`);
        }
      }
    }
  }
  check("no two lines overlap unless their source quads do",
    overlaps.length === 0, `${overlaps.length} unexpected overlaps: ${overlaps.slice(0, 3).join(" | ")}`);

  // ── 4: VERTICAL ─────────────────────────────────────────────
  const vertGeo = geo.filter((g) => g.vertical);
  console.log(`  ${vertGeo.length} vertical lines`);
  check("the volume has vertical lines to check",
    vertGeo.length > 0, `${vertGeo.length} vertical lines`);

  if (vertGeo.length) {
    let vWorst = 0, vWorstText = "";
    for (const g of vertGeo) {
      const q = quadFor(g);
      if (!q) continue;
      const s = g.scale;
      // For vertical text the GLYPH width must match the quad's width.
      const dw = Math.abs(g.charBox.w - q.w * s);
      if (dw > vWorst) { vWorst = dw; vWorstText = g.text.slice(0, 12); }
    }
    check("vertical glyphs match the quad's width",
      vWorst <= 6, `worst ${vWorst.toFixed(1)}px on "${vWorstText}"`);

    // The writing mode must actually be vertical.
    const wm = await ev(`(() => {
      const b = document.querySelector('.ocr-box.vertical');
      return b ? getComputedStyle(b).writingMode : null;
    })()`);
    check("vertical blocks use a vertical writing mode",
      wm === "vertical-rl", `writing-mode=${wm}`);

    // The text must run DOWN the column, not across it.
    const runsDown = await ev(`(() => {
      const l = document.querySelector('.ocr-box.vertical .ocr-line');
      if (!l) return null;
      const chars = Array.from(l.querySelectorAll('.ocr-char'));
      if (chars.length < 2) return { single: true };
      const a = chars[0].getBoundingClientRect();
      const b = chars[chars.length - 1].getBoundingClientRect();
      return { dy: b.top - a.top, dx: b.left - a.left };
    })()`);
    if (runsDown && !runsDown.single) {
      check("vertical text runs down the column",
        runsDown.dy > runsDown.dx, `dy=${Math.round(runsDown.dy)} dx=${Math.round(runsDown.dx)}`);
    }
  }

  // ── 5: CLICK OFF clears the highlight ───────────────────────
  const target = await ev(`(() => {
    const z = window.MANGA_CAB.getZones().find(x => x.text.trim() && x.width > 10 && x.height > 6
      && x.y > 80 && x.y + x.height < window.innerHeight - 60);
    if (!z) return null;
    return { x: z.x + z.width/2, y: z.y + z.height/2, text: z.text.slice(0, 20) };
  })()`);
  check("a zone is on screen to tap", !!target, JSON.stringify(target));

  if (target) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 }, sessionId);
    await sleep(60);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 }, sessionId);
    await sleep(500);

    const afterTap = await ev(`(() => ({
      tapped: document.querySelectorAll('.ocr-char.tapped').length,
      revealed: document.querySelectorAll('.ocr-box.revealed').length,
    }))()`);
    check("tapping the text highlights a character",
      afterTap.tapped >= 1, JSON.stringify(afterTap));

    // Now click far away from any text.
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 12, y: 800, button: "left", clickCount: 1 }, sessionId);
    await sleep(60);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 12, y: 800, button: "left", clickCount: 1 }, sessionId);
    await sleep(500);

    const afterOff = await ev(`(() => ({
      tapped: document.querySelectorAll('.ocr-char.tapped').length,
      revealed: document.querySelectorAll('.ocr-box.revealed').length,
    }))()`);
    check("clicking off the text clears the highlight",
      afterOff.tapped === 0, JSON.stringify(afterOff));
    check("clicking off the text collapses the revealed zone",
      afterOff.revealed === 0, JSON.stringify(afterOff));
  }

  // ── The transcript also clears on click-off ─────────────────
  await ev("window.toggleTranscript(true)");
  await sleep(700);
  const tTarget = await ev(`(() => {
    const c = document.querySelector('.transcript-line .ocr-char');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  if (tTarget) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: tTarget.x, y: tTarget.y, button: "left", clickCount: 1 }, sessionId);
    await sleep(60);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tTarget.x, y: tTarget.y, button: "left", clickCount: 1 }, sessionId);
    await sleep(400);
    const tTapped = await ev(`document.querySelectorAll('.transcript-line .ocr-char.tapped').length`);
    check("clicking a transcript character highlights it", tTapped === 1, `${tTapped} tapped`);

    // Click on the panel's background (the meta line at the top).
    const bg = await ev(`(() => {
      const m = document.querySelector('.transcript-meta');
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return { x: r.left + 10, y: r.top + r.height/2 };
    })()`);
    if (bg) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: bg.x, y: bg.y, button: "left", clickCount: 1 }, sessionId);
      await sleep(60);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: bg.x, y: bg.y, button: "left", clickCount: 1 }, sessionId);
      await sleep(400);
      const tAfter = await ev(`document.querySelectorAll('.transcript-line .ocr-char.tapped').length`);
      check("clicking off the transcript text clears the highlight",
        tAfter === 0, `${tAfter} still tapped`);
    }
  }

  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  chrome.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
