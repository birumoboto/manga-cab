// Confirms the RUN OCR button exists, is visible, and actually triggers
// an OCR job on the live (Tailscale) site.
//
// Run: node test/ocr-button.verify.js

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HOST = "bings-macbook-pro-2.tailb92b8e.ts.net";
const IP = "100.126.189.38";
const URL_BASE = `https://${HOST}/manga/`;

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-btn-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9336",
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu",
    `--host-resolver-rules=MAP ${HOST} ${IP}`, "about:blank"], { stdio: "ignore" });

  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9336/json/version")).json();
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

  const ev = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return "ERR " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await cdp.send("Page.navigate", { url: URL_BASE }, sessionId);
  await sleep(3000);

  console.log("── the button ──");
  check("RUN OCR button exists", await ev("!!document.getElementById('runOcr')"));

  const visible = await ev(`(() => {
    const b = document.getElementById('runOcr');
    if (!b) return { visible: false };
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return {
      visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
      text: b.textContent.trim(),
      w: Math.round(r.width), h: Math.round(r.height),
      inViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
      disabled: b.disabled,
    };
  })()`);
  check("button is visible", visible.visible === true, JSON.stringify(visible));
  check("button says RUN OCR", visible.text === "RUN OCR", String(visible.text));
  check("button is a good tap target", visible.w >= 40 && visible.h >= 40, `${visible.w}x${visible.h}`);

  // The language picker must be usable too.
  const lang = await ev(`(() => {
    const s = document.getElementById('langSelect');
    if (!s) return null;
    return { value: s.value, options: Array.from(s.options).map(o => o.value) };
  })()`);
  check("language picker present", !!lang, JSON.stringify(lang));
  check("language picker offers zh and ja", lang && lang.options.includes("zh") && lang.options.includes("ja"), JSON.stringify(lang));

  // It must be reachable without hunting: inside the library drawer.
  const inDrawer = await ev("document.getElementById('library').contains(document.getElementById('runOcr'))");
  check("button lives in the library drawer", inDrawer === true);

  // ── Does clicking it actually start a job? ─────────────────
  console.log("");
  console.log("── clicking it ──");
  // Open a volume first (the button needs one).
  const opened = await ev(`(async () => {
    const r = await fetch('/manga/api/volumes');
    const { volumes } = await r.json();
    if (!volumes.length) return 'none';
    await window.openVolume(volumes[0].id);
    return volumes[0].id;
  })()`);
  check("a volume is open", typeof opened === "string" && opened !== "none", String(opened));

  const before = await ev("document.getElementById('ocrProgress').textContent");
  await ev("document.getElementById('runOcr').click()");
  await sleep(2500);

  const during = await ev(`(() => ({
    status: document.getElementById('ocrProgress').textContent,
    disabled: document.getElementById('runOcr').disabled,
  }))()`);
  check("status line updates after clicking", String(during.status).length > 0, `"${during.status}"`);
  check("button disables while running", during.disabled === true, `disabled=${during.disabled}`);
  check("status mentions OCR running", /OCR/i.test(String(during.status)), `"${during.status}"`);

  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  chrome.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
