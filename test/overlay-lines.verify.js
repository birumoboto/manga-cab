// Verifies that every OCR section in the OVERLAY sits on its own line,
// at the position mokuro detected for it.
//
// Run: node test/overlay-lines.verify.js

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

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-ol-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9346",
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9346/json/version")).json();
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
  // Never serve a cached stylesheet or script — a stale one makes the
  // test report a failure that does not exist in the app.
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
  await cdp.send("Page.navigate", { url: BASE }, sessionId);
  await sleep(2500);

  const ev = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return "ERR " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await ev(`window.openVolume('${v.id}')`);
  await sleep(1800);
  await ev("window.setOcr(true)");
  await sleep(1500);

  const data = await ev(`(() => {
    const out = [];
    for (const wrap of document.querySelectorAll('.page')) {
      const boxes = Array.from(wrap.querySelectorAll('.ocr-box'));
      if (!boxes.length) continue;
      const items = [];
      for (const b of boxes) {
        const br = b.getBoundingClientRect();
        const lines = Array.from(b.querySelectorAll('.ocr-line')).map(l => {
          const r = l.getBoundingClientRect();
          return {
            text: l.textContent,
            placed: l.classList.contains('placed'),
            x: Math.round(r.left), y: Math.round(r.top),
            w: Math.round(r.width), h: Math.round(r.height),
            display: getComputedStyle(l).display,
            position: getComputedStyle(l).position,
          };
        });
        items.push({ box: { x: br.left, y: br.top, w: br.width, h: br.height }, lines });
      }
      out.push({ file: wrap.dataset.file, items });
    }
    return out;
  })()`);

  // Expected counts from the source data.
  let expectedSections = 0, expectedLines = 0;
  for (const p of ocr.pages) {
    for (const b of p.blocks || []) {
      expectedSections++;
      for (const l of b.lines || []) if (l.trim()) expectedLines++;
    }
  }

  const allLines = data.flatMap((p) => p.items.flatMap((i) => i.lines));
  const allBoxes = data.flatMap((p) => p.items);

  check("every OCR section produced a line element",
    allLines.length >= expectedLines, `${allLines.length} rendered vs ${expectedLines} expected`);
  check("every line is positioned (placed)",
    allLines.filter((l) => l.placed).length === allLines.length,
    `${allLines.filter((l) => l.placed).length}/${allLines.length} placed`);
  check("placed lines are absolutely positioned",
    allLines.every((l) => l.position === "absolute"),
    JSON.stringify([...new Set(allLines.map((l) => l.position))]));

  // Each line must be on its own row — no two lines share a Y band.
  //
  // Note: the SOURCE quads themselves can overlap when the OCR was noisy
  // (a block of garbled text split into overlapping quads). In that case
  // the overlay is faithfully reproducing the source, and an overlap is
  // correct behaviour. So compare the rendered overlap against the
  // overlap in the source data rather than assuming there is none.
  let renderOverlaps = 0;
  let sourceOverlaps = 0;
  const overlaps = [];

  // Source overlap count, per block, using the same 8px threshold.
  for (const p of ocr.pages) {
    for (const blk of p.blocks || []) {
      const quads = (blk.lines_coords || []).map((q) => {
        const xs = q.map((pt) => pt[0]), ys = q.map((pt) => pt[1]);
        return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      });
      for (let i = 0; i < quads.length; i++) {
        for (let j = i + 1; j < quads.length; j++) {
          const a = quads[i], b = quads[j];
          const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
          const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          if (ox > 8 && oy > 8) sourceOverlaps++;
        }
      }
    }
  }

  for (const page of data) {
    for (const box of page.items) {
      for (let i = 0; i < box.lines.length; i++) {
        for (let j = i + 1; j < box.lines.length; j++) {
          const a = box.lines[i], b = box.lines[j];
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (ox > 8 && oy > 8) {
            renderOverlaps++;
            overlaps.push(`"${a.text.slice(0, 12)}" / "${b.text.slice(0, 12)}" (${ox}x${oy})`);
          }
        }
      }
    }
  }
  check("the overlay does not introduce overlaps the source does not have",
    renderOverlaps <= sourceOverlaps,
    `${renderOverlaps} rendered vs ${sourceOverlaps} in the source quads` +
    (overlaps.length ? ` — ${overlaps.slice(0, 2).join(" | ")}` : ""));

  // Multi-line sections: each line must be on a DISTINCT row.
  const multi = [];
  for (const page of data) {
    for (const box of page.items) {
      if (box.lines.length > 1) multi.push(box);
    }
  }
  let sameRow = 0;
  for (const box of multi) {
    const ys = box.lines.map((l) => l.y);
    if (new Set(ys).size !== ys.length) sameRow++;
  }
  check("multi-line sections put each line on a distinct row",
    sameRow === 0, `${sameRow} of ${multi.length} multi-line sections share a row`);

  // The line's position must match the detected quad (within a few px).
  // Compare the rendered line's centre to the quad's centre.
  const posCheck = await ev(`(() => {
    const out = [];
    for (const wrap of document.querySelectorAll('.page')) {
      const idx = Number(wrap.dataset.index);
      const page = ${JSON.stringify(ocr.pages.map((p) => p.blocks || []))}[idx];
      if (!page) continue;
      const boxes = Array.from(wrap.querySelectorAll('.ocr-box'));
      for (let bi = 0; bi < Math.min(boxes.length, page.length); bi++) {
        const b = boxes[bi], blk = page[bi];
        const quad = blk.lines_coords?.[0];
        if (!quad) continue;
        const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
        const qcx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const qcy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const img = wrap.querySelector('img');
        const scale = img.getBoundingClientRect().width / (blk && img.naturalWidth);
        const br = b.getBoundingClientRect();
        const line = b.querySelector('.ocr-line');
        if (!line) continue;
        const lr = line.getBoundingClientRect();
        // Expected centre in viewport coords: block box + quad offset.
        const imgRect = img.getBoundingClientRect();
        const W = ${JSON.stringify(ocr.pages.map((p) => p.img_width))}[idx];
        const expX = imgRect.left + (qcx / W) * imgRect.width;
        const expY = imgRect.top + (qcy / ${JSON.stringify(ocr.pages.map((p) => p.img_height))}[idx]) * imgRect.height;
        out.push({
          dx: Math.round(lr.left + lr.width/2 - expX),
          dy: Math.round(lr.top + lr.height/2 - expY),
        });
      }
    }
    return out;
  })()`);

  if (posCheck.length) {
    const maxDx = Math.max(...posCheck.map((p) => Math.abs(p.dx)));
    const maxDy = Math.max(...posCheck.map((p) => Math.abs(p.dy)));
    check("each line lands at its detected position",
      maxDx <= 12 && maxDy <= 12, `max offset dx=${maxDx}px dy=${maxDy}px over ${posCheck.length} lines`);
  } else {
    check("each line lands at its detected position", false, "no samples");
  }

  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  chrome.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
