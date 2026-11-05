// Captures screenshots of the library drawer showing the RUN OCR button.
//
// Run: node test/screenshot.js

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HOST = "bings-macbook-pro-2.tailb92b8e.ts.net";
const IP = "100.126.189.38";
const URL_BASE = `https://${HOST}/manga/`;
const OUT = "/Users/bing/manga-reader";

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-shot-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9337",
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu",
    `--host-resolver-rules=MAP ${HOST} ${IP}`, "about:blank"], { stdio: "ignore" });

  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9337/json/version")).json();
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

  // 1. Library drawer open, scrolled to the OCR section.
  await ev("document.querySelector('.library-body').scrollTop = 320");
  await sleep(600);
  let shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(path.join(OUT, "shot-library-ocr.png"), Buffer.from(shot.data, "base64"));
  console.log("wrote shot-library-ocr.png");

  // 2. Reading a volume with the OCR text layer on.
  const opened = await ev(`(async () => {
    const r = await fetch('/manga/api/volumes');
    const { volumes } = await r.json();
    if (!volumes.length) return 'none';
    await window.openVolume(volumes[0].id);
    await new Promise(r2 => setTimeout(r2, 1800));
    window.setOcr(true);
    return volumes[0].title;
  })()`);
  await sleep(1500);
  shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(path.join(OUT, "shot-reader-ocr.png"), Buffer.from(shot.data, "base64"));
  console.log("wrote shot-reader-ocr.png (volume:", opened, ")");

  chrome.kill();
}

main().catch((e) => { console.error(e); process.exit(1); });
