// Verifies the clickable text zones:
//
//   - every detected text block has a zone
//   - a zone covers the artwork area where the text is
//   - tapping inside a zone reveals it: white background, dark text
//   - only one zone is revealed at a time
//   - tapping outside collapses the zone
//
// Run: node test/zones.verify.js

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
  // A block whose OCR read nothing has no zone — there is nothing to
  // reveal. Count only the blocks that actually carry text.
  const expectedBlocks = ocr.pages.reduce(
    (n, p) => n + (p.blocks || []).filter((b) => (b.lines || []).join("").trim()).length, 0);
  const emptyBlocks = ocr.pages.reduce(
    (n, p) => n + (p.blocks || []).filter((b) => !(b.lines || []).join("").trim()).length, 0);
  console.log(`volume "${v.title}" — ${expectedBlocks} text blocks (${emptyBlocks} empty, skipped)`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-zones-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9357",
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9357/json/version")).json();
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
  await sleep(1500);

  // ── Zones exist ─────────────────────────────────────────────
  const zones = await ev(`(() => {
    const z = window.MANGA_CAB.getZones();
    return {
      count: z.length,
      withText: z.filter(x => x.text.trim()).length,
      withSize: z.filter(x => x.width > 0 && x.height > 0).length,
      first: z[0] ? { text: z[0].text.slice(0, 20), x: Math.round(z[0].x), y: Math.round(z[0].y),
                      w: Math.round(z[0].width), h: Math.round(z[0].height), page: z[0].page } : null,
    };
  })()`);
  console.log("  zones:", JSON.stringify(zones));
  check("every detected block has a zone", zones.count === expectedBlocks,
    `${zones.count} zones vs ${expectedBlocks} blocks`);
  check("every zone has text", zones.withText === zones.count, `${zones.withText}/${zones.count}`);
  check("every zone has a size", zones.withSize === zones.count, `${zones.withSize}/${zones.count}`);
  check("the first zone has a sensible rect",
    zones.first && zones.first.w > 4 && zones.first.h > 4, JSON.stringify(zones.first));

  // ── A zone must cover the artwork area where the text is ───
  // The zone is measured from the CHARACTERS, because the text can
  // overflow the detected line quad (the ink box is often narrower than
  // the laid-out text). So the zone must contain every character, and
  // every character must fall inside the zone.
  const covers = await ev(`(() => {
    const out = [];
    for (const b of document.querySelectorAll('.ocr-box')) {
      const chars = Array.from(b.querySelectorAll('.ocr-char'));
      if (!chars.length) continue;
      const cr = chars.map(c => c.getBoundingClientRect());
      const cl = Math.min(...cr.map(r => r.left));
      const ct = Math.min(...cr.map(r => r.top));
      const cR = Math.max(...cr.map(r => r.right));
      const cB = Math.max(...cr.map(r => r.bottom));

      // The zone, computed the same way the app does.
      const zone = window.MANGA_CAB.getZones().find(z => z.el === b);
      if (!zone) { out.push({ text: b.textContent.slice(0,14), why: 'no zone' }); continue; }

      // Every character must be inside the zone (with the padding).
      const inside = cl >= zone.x - 1 && ct >= zone.y - 1
                  && cR <= zone.x + zone.width + 1 && cB <= zone.y + zone.height + 1;
      if (!inside) {
        out.push({
          text: b.textContent.slice(0,14),
          chars: [Math.round(cl),Math.round(ct),Math.round(cR),Math.round(cB)],
          zone: [Math.round(zone.x),Math.round(zone.y),Math.round(zone.x+zone.width),Math.round(zone.y+zone.height)],
        });
      }
    }
    return { bad: out.length, list: out.slice(0,3) };
  })()`);
  check("every zone contains its characters", covers.bad === 0,
    `${covers.bad} zones miss their characters ${JSON.stringify(covers.list)}`);

  // ── Tapping a zone reveals it ──────────────────────────────
  const target = await ev(`(() => {
    const z = window.MANGA_CAB.getZones().find(x => x.text.trim() && x.width > 10 && x.height > 6
      && x.y > 80 && x.y + x.height < window.innerHeight - 60);
    if (!z) return null;
    return { text: z.text.slice(0, 24), x: z.x + z.width/2, y: z.y + z.height/2,
             index: z.index, page: z.page, block: z.block };
  })()`);
  check("a zone is on screen to tap", !!target, JSON.stringify(target));

  if (target) {
    await ev("window.getSelection().removeAllRanges()");
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 }, sessionId);
    await sleep(60);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 }, sessionId);
    await sleep(600);

    const revealed = await ev(`(() => {
      const boxes = Array.from(document.querySelectorAll('.ocr-box'));
      const rev = boxes.filter(b => b.classList.contains('revealed'));
      const b = rev[0];
      if (!b) return { none: true };
      const cs = getComputedStyle(b);
      // The white panel is painted by the ::before pseudo-element of the
      // LINE, not the block — a block can hold several lines with
      // different quads, and the panel has to hug the text.
      const line = b.querySelector('.ocr-line');
      const before = getComputedStyle(line, '::before');
      const charCs = getComputedStyle(b.querySelector('.ocr-char'));
      return {
        count: rev.length,
        text: b.textContent.slice(0, 24),
        bg: cs.backgroundColor,
        // The white panel is painted by the ::before pseudo-element.
        panelBg: before.backgroundColor,
        panelContent: before.content,
        charColor: charCs.color,
        charFill: charCs.webkitTextFillColor,
        visible: cs.visibility !== 'hidden' && cs.display !== 'none',
      };
    })()`);
    console.log("  revealed:", JSON.stringify(revealed));
    check("tapping a zone reveals it", revealed.count === 1, JSON.stringify(revealed));
    check("the revealed zone has a WHITE background",
      /rgb\(255, 255, 255\)/.test(revealed.panelBg || ""), `panel bg=${revealed.panelBg}`);
    check("the revealed text is DARK, not transparent",
      revealed.charColor !== "rgba(0, 0, 0, 0)" && revealed.charFill !== "rgba(0, 0, 0, 0)",
      `color=${revealed.charColor} fill=${revealed.charFill}`);
    check("the revealed text is visible", revealed.visible === true);

    // ── Only one zone at a time ───────────────────────────────
    const second = await ev(`(() => {
      const z = window.MANGA_CAB.getZones().find(x => !x.revealed && x.text.trim() && x.width > 10
        && x.y > 80 && x.y + x.height < window.innerHeight - 60);
      if (!z) return null;
      return { x: z.x + z.width/2, y: z.y + z.height/2, text: z.text.slice(0, 20) };
    })()`);
    if (second) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: second.x, y: second.y, button: "left", clickCount: 1 }, sessionId);
      await sleep(60);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: second.x, y: second.y, button: "left", clickCount: 1 }, sessionId);
      await sleep(600);
      const after = await ev(`document.querySelectorAll('.ocr-box.revealed').length`);
      check("only one zone is revealed at a time", after === 1, `${after} revealed`);
    }

    // ── Tapping outside collapses the zone ────────────────────
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 15, y: 780, button: "left", clickCount: 1 }, sessionId);
    await sleep(60);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 15, y: 780, button: "left", clickCount: 1 }, sessionId);
    await sleep(600);
    const collapsed = await ev(`document.querySelectorAll('.ocr-box.revealed').length`);
    check("tapping outside collapses the zone", collapsed === 0, `${collapsed} still revealed`);
  }

  // ── The API exposes the zones ──────────────────────────────
  const api = await ev(`(() => {
    const M = window.MANGA_CAB;
    return {
      hasGetZones: typeof M.getZones === 'function',
      hasHitZone: typeof M.hitZone === 'function',
      hasReveal: typeof M.revealZone === 'function',
      hasCollapse: typeof M.collapseZones === 'function',
    };
  })()`);
  check("the API exposes the zone functions",
    api.hasGetZones && api.hasHitZone && api.hasReveal && api.hasCollapse,
    JSON.stringify(api));

  // hitZone must find the zone under a point.
  const hit = await ev(`(() => {
    const z = window.MANGA_CAB.getZones().find(x => x.text.trim() && x.width > 10 && x.height > 6);
    if (!z) return { none: true };
    const found = window.MANGA_CAB.hitZone(z.x + z.width/2, z.y + z.height/2);
    return { expected: z.text.slice(0, 16), got: found ? found.text.slice(0, 16) : null };
  })()`);
  check("hitZone finds the zone under a point",
    !hit.none && hit.got === hit.expected, JSON.stringify(hit));

  // ── Scrolling still works with zones in play ───────────────
  const scroll = await ev(`(async () => {
    const before = document.getElementById('reader').scrollTop;
    document.getElementById('reader').scrollTop = 500;
    await new Promise(r => setTimeout(r, 300));
    return { before, after: document.getElementById('reader').scrollTop };
  })()`);
  check("the reader still scrolls", scroll.after > scroll.before,
    `${scroll.before} -> ${scroll.after}`);

  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  chrome.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
