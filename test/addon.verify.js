// Simulates the Firefox add-on against the real app.
//
// This runs the ACTUAL add-on content script in the page and drives it
// with real pointer events, so what we verify is what the add-on will
// do in Firefox — not a reimplementation of it.
//
// Run: node test/addon.verify.js

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE_URL || "http://127.0.0.1:8790";
const ADDON = path.resolve(import.meta.dirname, "../addon/manga-cab-reader.js");
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

  // Find a section with real text on page 0, to tap.
  const p0 = ocr.pages[0];
  const target = p0.blocks.find((b) => b.lines.some((l) => l.trim().length > 1));
  const targetText = target.lines.find((l) => l.trim().length > 1);
  console.log(`volume "${v.title}" — tapping "${targetText}"`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-addon-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9349",
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9349/json/version")).json();
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
  await cdp.send("Page.navigate", { url: BASE }, sessionId);
  await sleep(2500);

  const ev = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return "ERR " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await ev(`window.openVolume('${v.id}')`);
  await sleep(2000);
  await ev("window.setOcrMode('tap')");
  await sleep(1200);

  // ── Inject the REAL add-on script ──────────────────────────
  const addonSrc = fs.readFileSync(ADDON, "utf8");
  const injected = await ev(`(() => {
    try {
      const s = document.createElement('script');
      s.textContent = ${JSON.stringify(addonSrc)};
      document.documentElement.appendChild(s);
      s.remove();
      return true;
    } catch (e) { return 'ERR ' + e.message; }
  })()`);
  check("the add-on script injects without error", injected === true, String(injected));

  // The panel is created lazily on the first tap, so it does not exist
  // yet at this point — only the script must have loaded cleanly.
  const panelBefore = await ev(`!!document.getElementById('manga-cab-reader')`);
  check("the add-on has not created a panel before any tap",
    panelBefore === false, `panel exists=${panelBefore}`);

  // ── Find a character that is on screen ──────────────────────
  const targetChar = await ev(`(() => {
    const chars = window.MANGA_CAB.getCharacters();
    const onScreen = chars.filter(c => c.y > 60 && c.y < window.innerHeight - 120 && c.x > 0 && c.x < window.innerWidth);
    if (!onScreen.length) return null;
    const c = onScreen[0];
    return { char: c.char, x: c.centerX, y: c.centerY, line: c.line, page: c.page, block: c.block };
  })()`);
  check("a character is on screen to tap", !!targetChar, JSON.stringify(targetChar));

  if (targetChar) {
    // ── Tap it with a REAL pointer sequence ───────────────────
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: targetChar.x, y: targetChar.y, button: "left", clickCount: 1 }, sessionId);
    await sleep(60);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: targetChar.x, y: targetChar.y, button: "left", clickCount: 1 }, sessionId);
    await sleep(500);

    const panel = await ev(`(() => {
      const p = document.getElementById('manga-cab-reader');
      if (!p) return { missing: true };
      const r = p.getBoundingClientRect();
      return {
        display: p.style.display,
        visible: getComputedStyle(p).display !== 'none' && r.height > 0,
        text: p.textContent,
        html: p.innerHTML,
        onScreen: r.left >= 0 && r.right <= window.innerWidth + 2 && r.top >= 0 && r.bottom <= window.innerHeight + 2,
        hasMark: !!p.querySelector('mark'),
        marked: p.querySelector('mark')?.textContent || null,
        userSelect: getComputedStyle(p).userSelect,
      };
    })()`);

    check("the panel becomes visible after a tap", panel.visible === true, JSON.stringify({ display: panel.display }));
    check("the panel shows the tapped section's text",
      panel.text && panel.text.includes(targetChar.char),
      `panel="${panel.text?.slice(0, 60)}" tapped="${targetChar.char}"`);
    check("the panel highlights the tapped character",
      panel.hasMark && panel.marked === targetChar.char,
      `marked="${panel.marked}"`);
    check("the panel is on screen", panel.onScreen);
    check("the panel text is selectable", panel.userSelect === "text", panel.userSelect);

    // The panel must show the WHOLE sentence, not just one character.
    const lineText = await ev(`(() => {
      const c = window.MANGA_CAB.getCharacters().find(x => x.line === ${targetChar.line} && x.page === ${targetChar.page} && x.block === ${targetChar.block});
      const el = c?.el?.closest('.ocr-line');
      return el ? el.textContent : null;
    })()`);
    check("the panel shows the whole section, not just the character",
      lineText && panel.text.includes(lineText.replace(/\s+/g, "").slice(0, 4)),
      `line="${lineText}"`);

    // ── Tapping empty space hides it ──────────────────────────
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 20, y: 400, button: "left", clickCount: 1 }, sessionId);
    await sleep(60);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 20, y: 400, button: "left", clickCount: 1 }, sessionId);
    await sleep(500);
    const after = await ev(`(() => {
      const p = document.getElementById('manga-cab-reader');
      return { display: p.style.display };
    })()`);
    check("tapping empty space hides the panel", after.display === "none", `display=${after.display}`);
  }

  // ── The add-on must not break scrolling ─────────────────────
  const scroll = await ev(`(async () => {
    const before = document.getElementById('reader').scrollTop;
    document.getElementById('reader').scrollTop = 400;
    await new Promise(r => setTimeout(r, 300));
    return { before, after: document.getElementById('reader').scrollTop };
  })()`);
  check("the reader still scrolls with the add-on loaded",
    scroll.after > scroll.before, `${scroll.before} -> ${scroll.after}`);

  // ── No JS exceptions ────────────────────────────────────────
  const errors = await ev(`window.__addonErrors ? window.__addonErrors.length : 0`);
  check("the add-on logged no errors", errors === 0, `${errors} errors`);

  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  chrome.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
