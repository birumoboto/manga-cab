// Verifies the transcript button is actually VISIBLE and REACHABLE on a
// phone-sized viewport — not just present in the DOM.
//
// Run: node test/transcript-visible.verify.js

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

const DEVICES = [
  { name: "Galaxy S24 Ultra", w: 412, h: 915 },
  { name: "iPhone 15 Pro", w: 393, h: 852 },
  { name: "iPhone SE", w: 375, h: 667 },
  { name: "small Android", w: 360, h: 740 },
];

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-tv-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9347",
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9347/json/version")).json();
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

  for (const d of DEVICES) {
    console.log(`\n── ${d.name} (${d.w}x${d.h}) ──`);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: d.w, height: d.h, deviceScaleFactor: 2, mobile: true,
    }, sessionId);
    await cdp.send("Page.navigate", { url: BASE }, sessionId);
    await sleep(2200);

    const ev = async (expr) => {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) return "ERR " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };

    // The transcript button lives in the READER's header, so open a
    // volume first — otherwise the whole reader screen is display:none
    // and every measurement is 0x0.
    const { volumes } = await (await fetch(`${BASE}/api/volumes`)).json();
    await ev(`window.openVolume('${volumes[0].id}')`);
    await sleep(1600);

    const btn = await ev(`(() => {
      const b = document.getElementById('textToggle');
      if (!b) return { missing: true };
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      const top = document.getElementById('ocrToggle').getBoundingClientRect();
      return {
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
        inViewport: r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight,
        gapFromOcr: Math.round(r.left - top.right),
        viewport: window.innerWidth,
        ariaLabel: b.getAttribute('aria-label'),
      };
    })()`);

    check("the button exists", !btn.missing, JSON.stringify(btn));
    if (btn.missing) continue;

    // The OCR sheet is the other entry point — it holds VIEW TRANSCRIPT.
    await ev("window.toggleSheet()");
    await sleep(500);
    const drawerBtn = await ev(`(() => {
      const b = document.getElementById('textPanelBtn');
      if (!b) return { missing: true };
      const r = b.getBoundingClientRect();
      return { text: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    check("the sheet has a VIEW TRANSCRIPT button",
      !drawerBtn.missing && /TRANSCRIPT/i.test(drawerBtn.text) && drawerBtn.h >= 40,
      JSON.stringify(drawerBtn));
    await ev("window.toggleSheet()");
    await sleep(350);

    check("the button is visible", btn.display !== "none" && btn.visibility === "visible" && btn.opacity !== "0",
      `display=${btn.display} visibility=${btn.visibility} opacity=${btn.opacity}`);
    check("the button is inside the viewport", btn.inViewport,
      `x=${btn.x} w=${btn.w} viewport=${btn.viewport}`);
    check("the button is a decent tap target", btn.w >= 32 && btn.h >= 32,
      `${btn.w}x${btn.h}`);
    check("the button is not overlapping the OCR toggle", btn.gapFromOcr >= 0,
      `gap=${btn.gapFromOcr}px`);
    check("the button has an accessible label", !!btn.ariaLabel, btn.ariaLabel);

    // Tapping it must open the panel.
    await ev("window.toggleTranscript(true)");
    await sleep(600);
    const panel = await ev(`(() => {
      const p = document.getElementById('transcript');
      const r = p.getBoundingClientRect();
      const b = document.getElementById('transcriptBody');
      return {
        hidden: p.hidden, open: p.classList.contains('open'),
        w: Math.round(r.width), left: Math.round(r.left),
        onScreen: r.left < window.innerWidth && r.right > 0,
        lines: b.querySelectorAll('.transcript-line').length,
        headVisible: getComputedStyle(p.querySelector('.transcript-head')).display !== 'none',
      };
    })()`);
    check("tapping the button opens the panel", !panel.hidden && panel.open, JSON.stringify(panel));
    check("the panel is on screen", panel.onScreen, `left=${panel.left} w=${panel.w}`);
    check("the panel has a visible header", panel.headVisible);
    await ev("window.toggleTranscript(false)");
    await sleep(300);
  }

  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  chrome.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
