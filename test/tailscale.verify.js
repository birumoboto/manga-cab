// Verify the reader works through the real Tailscale HTTPS endpoint,
// mounted under the /manga path prefix (so it shares a hostname with
// another app). This exercises the BASE-prefix resolution.
//
// Run: node test/tailscale.verify.js

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HOST = "bings-macbook-pro-2.tailb92b8e.ts.net";
const IP = "100.126.189.38";
const URL_BASE = `https://${HOST}/manga/`;

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`); pass++; }
  else { console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-ts-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=9335", `--user-data-dir=${profile}`,
    "--no-first-run", "--disable-gpu",
    // The host cannot resolve its own MagicDNS name, so map it.
    `--host-resolver-rules=MAP ${HOST} ${IP}`,
    "about:blank",
  ], { stdio: "ignore" });

  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9335/json/version")).json();
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
  await cdp.send("Log.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2, mobile: true }, sessionId);

  const errors = [];
  cdp.ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === "Runtime.exceptionThrown") {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      errors.push(m.params.entry.text);
    }
  });

  const ev = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return "ERR " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // Never serve a cached stylesheet or script — a stale one makes the
  // test report a failure that does not exist in the app.
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
  await cdp.send("Page.navigate", { url: URL_BASE }, sessionId);
  await sleep(3000);

  console.log("── via tailscale ──");
  check("page loads over https", (await ev("document.title")) === "MANGA.CAB — Webtoon Reader", String(await ev("document.title")));
  check("prefix detected", (await ev("window.location.pathname")).startsWith("/manga"), String(await ev("window.location.pathname")));

  const libOk = await ev(`(async () => {
    try {
      const r = await fetch('/manga/api/volumes');
      const d = await r.json();
      return Array.isArray(d.volumes) ? d.volumes.length : 'bad';
    } catch (e) { return 'ERR ' + e.message; }
  })()`);
  check("api reachable through the prefix", typeof libOk === "number", `${libOk} volumes`);

  // Open a volume and confirm pages load through the prefix.
  const opened = await ev(`(async () => {
    const r = await fetch('/manga/api/volumes');
    const { volumes } = await r.json();
    if (!volumes.length) return 'no volumes';
    await window.openVolume(volumes[0].id);
    await new Promise(r2 => setTimeout(r2, 1500));
    const imgs = Array.from(document.querySelectorAll('.page img'));
    await Promise.all(imgs.map(i => i.complete ? null : new Promise(r2 => { i.onload = r2; i.onerror = r2; })));
    return { id: volumes[0].id, pages: imgs.length, loaded: imgs.filter(i => i.naturalWidth > 0).length,
             src: imgs[0]?.getAttribute('src') };
  })()`);
  check("volume opens and pages load", opened && typeof opened === "object", JSON.stringify(opened));
  if (opened && typeof opened === "object") {
    check("page urls carry the prefix", String(opened.src).startsWith("/manga/"), String(opened.src));
    check("all images loaded", opened.loaded === opened.pages, `${opened.loaded}/${opened.pages}`);
  }

  check("no JS exceptions", errors.length === 0, errors.slice(0, 3).join(" | "));

  chrome.kill();
  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
