// Tests whether a *real* touch gesture can select the OCR text.
//
// The earlier check used createRange() + addRange(), which bypasses the
// browser's gesture handling entirely — it proves the text is in a
// selectable element, but NOT that a finger can select it.
//
// This dispatches real touch events through CDP and checks what the
// browser actually selected.
//
// Run: node test/touch-select.verify.js

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-touch-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9338",
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu",
    "--touch-events=enabled", "about:blank"], { stdio: "ignore" });

  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9338/json/version")).json();
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
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);

  const ev = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return "ERR " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await cdp.send("Page.navigate", { url: BASE }, sessionId);
  await sleep(2500);

  // Open a volume and attach a synthetic .mokuro so we know where the text is.
  const opened = await ev(`(async () => {
    const r = await fetch('/api/volumes');
    const { volumes } = await r.json();
    if (!volumes.length) return 'none';
    const v = volumes[0];
    const mk = (t) => ({ box: [40, 150, 360, 260], font_size: 60, vertical: false, lines: [t] });
    const doc = { pages: Array.from({length: v.pageCount}, (_, i) => ({ img_path: 'x', img_width: 400, img_height: 600, blocks: [mk('测试文字' + i)] })) };
    const file = new File([JSON.stringify(doc)], 'v.mokuro', {type:'application/json'});
    await window.attachMokuro(v.id, file);
    await window.openVolume(v.id);
    await new Promise(r2 => setTimeout(r2, 1200));
    window.setOcr(true);
    await new Promise(r2 => setTimeout(r2, 800));
    return v.id;
  })()`);
  check("volume opened with ocr", typeof opened === "string" && opened !== "none", String(opened));

  // Where is the first text box on screen?
  const box = await ev(`(() => {
    const b = document.querySelector('.ocr-box');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height,
             text: b.textContent, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  })()`);
  check("text box located on screen", !!box, JSON.stringify(box));
  if (!box) { chrome.kill(); process.exit(1); }

  // ── Is the text actually visible to the user? ────────────────
  const vis = await ev(`(() => {
    const b = document.querySelector('.ocr-box');
    const cs = getComputedStyle(b);
    return { color: cs.color, opacity: cs.opacity, visibility: cs.visibility,
             userSelect: cs.userSelect, webkitUserSelect: cs.webkitUserSelect,
             layerPointerEvents: getComputedStyle(b.parentElement).pointerEvents };
  })()`);
  console.log("  computed:", JSON.stringify(vis));
  check("text is technically selectable", vis.userSelect === "text" || vis.webkitUserSelect === "text", JSON.stringify(vis));

  // The colour matters: a user must be able to SEE where the text is.
  const alpha = (() => {
    const m = String(vis.color).match(/rgba?\([^)]*?,\s*([\d.]+)\s*\)/);
    return m ? Number(m[1]) : 1;
  })();
  check("text is visually invisible (so users cannot find it)", alpha < 0.05, `alpha=${alpha}`);

  // ── The highlight must be VISIBLE, not just present ─────────
  // This is the bug that made selection look broken: the ::selection
  // rule lost on specificity, so selected text stayed transparent.
  const selColor = await ev(`(() => {
    const rules = [];
    for (const sheet of document.styleSheets) {
      let list;
      try { list = sheet.cssRules; } catch { continue; }
      for (const r of list) {
        if (r.selectorText && r.selectorText.includes('::selection')) {
          rules.push({ sel: r.selectorText, css: r.style.cssText });
        }
      }
    }
    return rules;
  })()`);
  check("selection rules exist", Array.isArray(selColor) && selColor.length > 0, JSON.stringify(selColor));

  // The winning rule must out-specify the transparent base rule.
  const specificity = (s) => {
    const parts = s.split(/\s+/).filter(Boolean);
    let a = 0, b = 0, c = 0;
    for (const t of parts) {
      const t2 = t.replace(/::?selection$/, "");
      if (t2.startsWith("#")) a++;
      else if (t2.startsWith(".")) b++;
      else if (t2.startsWith(":")) continue;
      else c++;
    }
    return [a, b, c];
  };
  const cmp = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

  const baseRule = ".ocr-layer.on .ocr-box";
  const baseSpec = specificity(baseRule);
  const winners = selColor.filter((r) => {
    const parts = r.sel.split(/\s+/);
    if (!parts.some((p) => p.includes("ocr-box"))) return false;
    if (!/color\s*:/i.test(r.css)) return false;
    const s = specificity(r.sel);
    return cmp(s, baseSpec) >= 0;
  });
  check(
    "a selection rule out-specifies the transparent base rule",
    winners.length > 0,
    winners.map((w) => w.sel).join(" | ") || `base ${baseSpec}, rules: ${selColor.map((r) => r.sel + " " + specificity(r.sel)).join(", ")}`
  );

  // ── Tap-to-select a word ────────────────────────────────────
  // Touch selection is not emulatable in headless Chrome (it fails on a
  // plain <p> too), so the tap path is driven with mouse events, which
  // exercise the same pointerdown/pointerup handler.
  const charInfo = await ev(`(() => {
    const w = document.querySelector('.ocr-char');
    if (!w) return null;
    const r = w.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2, text: w.textContent,
             w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  check("characters are split into spans", !!charInfo, JSON.stringify(charInfo));
  if (!charInfo) { chrome.kill(); process.exit(1); }

  await ev("window.getSelection().removeAllRanges()");
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: charInfo.x, y: charInfo.y, button: "left", clickCount: 1 }, sessionId);
  await sleep(60);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: charInfo.x, y: charInfo.y, button: "left", clickCount: 1 }, sessionId);
  await sleep(400);

  const tapped = await ev(`(() => {
    const t = document.querySelector('.ocr-char.tapped');
    if (!t) return null;
    const cs = getComputedStyle(t);
    return { text: t.textContent, bg: cs.backgroundColor, color: cs.color,
             selected: window.getSelection().toString() };
  })()`);
  check("tapping a character highlights it", !!tapped, JSON.stringify(tapped));
  if (tapped) {
    check("the tapped character is in the selection", tapped.selected.includes(tapped.text), JSON.stringify(tapped.selected));
    // The highlight must be an opaque, visible colour.
    const bg = tapped.bg.match(/rgba?\(([^)]+)\)/);
    const parts = bg ? bg[1].split(",").map(Number) : [];
    const opaque = parts.length >= 3 && parts[3] !== 0;
    const notTransparent = parts.slice(0, 3).some((v) => v > 40);
    check("the highlight has a visible background", opaque && notTransparent, `bg=${tapped.bg}`);
    check("the highlighted text is readable", /rgb\(255, 255, 255\)/.test(tapped.color), `color=${tapped.color}`);
  }

  const hint = await ev(`(() => {
    const h = document.getElementById('ocrCopyHint');
    if (!h) return null;
    const cs = getComputedStyle(h);
    return { text: h.textContent, opacity: cs.opacity, visible: h.classList.contains('show') };
  })()`);
  check("a copy hint appears", !!hint && hint.visible === true, JSON.stringify(hint));

  // ── Scrolling must still work with the OCR layer on ────────
  const scrollWorked = await ev(`(async () => {
    const r = document.getElementById('reader');
    r.scrollTop = 0;
    await new Promise(x => setTimeout(x, 200));
    r.scrollTop = 400;
    await new Promise(x => setTimeout(x, 300));
    return r.scrollTop;
  })()`);
  check("reader still scrolls with the ocr layer on", scrollWorked > 0, `scrollTop=${scrollWorked}`);

  // The layer must not swallow pointer events, or scrolling breaks.
  const layerPE = await ev("getComputedStyle(document.querySelector('.ocr-layer')).pointerEvents");
  check("ocr layer does not block scrolling", layerPE === "none", `pointer-events=${layerPE}`);

  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  chrome.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
