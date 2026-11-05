// Integration check: a REAL .mokuro file (produced by the mokuro OCR
// pipeline) attaches to a volume and renders its text overlay in the
// browser, with correct box geometry.
//
// Run: node test/mokuro.verify.js [path/to/volume.mokuro]

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8790;
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const MOKURO_PATH = process.argv[2] || "/tmp/zhvol.mokuro";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
    pass++;
  } else {
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
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
        const p = c.pending.get(m.id);
        c.pending.delete(m.id);
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
  if (!fs.existsSync(MOKURO_PATH)) {
    console.log(`SKIP  no .mokuro at ${MOKURO_PATH}`);
    return 0;
  }
  const mokuro = JSON.parse(fs.readFileSync(MOKURO_PATH, "utf8"));
  console.log(`using ${MOKURO_PATH}: ${mokuro.pages.length} pages, lang=${mokuro.lang || "?"}`);

  // Find a volume to attach to. Prefer one with a matching page count,
  // but fall back to any volume with at least one page.
  const { volumes } = await (await fetch(`${BASE}/api/volumes`)).json();
  let target = volumes.find((v) => v.pageCount === mokuro.pages.length);
  if (!target) target = volumes.find((v) => v.pageCount >= 1);
  if (!target) {
    console.log("SKIP  no volume available");
    return 0;
  }

  const fd = new FormData();
  fd.append("mokuro", new Blob([JSON.stringify(mokuro)], { type: "application/json" }), "vol.mokuro");
  const up = await fetch(`${BASE}/api/volumes/${target.id}/mokuro`, { method: "POST", body: fd });
  check("real .mokuro attached", up.ok, `HTTP ${up.status}`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-mk-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9334", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });

  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9334/json/version")).json();
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

  await ev(`window.openVolume('${target.id}')`);
  await sleep(1500);
  await ev("window.setOcr(true)");
  await sleep(900);

  const boxes = await ev("document.querySelectorAll('.ocr-box').length");
  check("ocr boxes rendered from the real file", boxes > 0, `${boxes} boxes`);

  const texts = await ev("Array.from(document.querySelectorAll('.ocr-box')).map(b => b.textContent).join('')");
  const expected = mokuro.pages.flatMap((p) => p.blocks.flatMap((b) => b.lines)).join("");
  check("overlay text matches the mokuro text", texts.length > 0 && expected.includes(texts.slice(0, 4)), `got "${texts.slice(0, 24)}" expected "${expected.slice(0, 24)}"`);

  // Geometry: the overlay box must sit inside its page.
  const geom = await ev(`(() => {
    const out = [];
    for (const wrap of document.querySelectorAll('.page')) {
      const pr = wrap.getBoundingClientRect();
      for (const b of wrap.querySelectorAll('.ocr-box')) {
        const r = b.getBoundingClientRect();
        out.push({
          inside: r.left >= pr.left - 2 && r.right <= pr.right + 2 && r.top >= pr.top - 2 && r.bottom <= pr.bottom + 2,
          w: Math.round(r.width), h: Math.round(r.height),
        });
      }
    }
    return out;
  })()`);
  check("all overlay boxes sit inside their page", Array.isArray(geom) && geom.length > 0 && geom.every((g) => g.inside), JSON.stringify(geom.slice(0, 3)));
  check("overlay boxes have real size", geom.every((g) => g.w > 4 && g.h > 4), JSON.stringify(geom.slice(0, 3)));

  // The Chinese text must actually be selectable.
  const sel = await ev(`(() => {
    const b = document.querySelector('.ocr-box');
    if (!b) return '';
    const r = document.createRange();
    r.selectNodeContents(b);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(r);
    return s.toString();
  })()`);
  check("chinese text is selectable", String(sel).length > 0, JSON.stringify(sel));

  // Vertical blocks should use vertical writing mode.
  const hasVertical = mokuro.pages.some((p) => p.blocks.some((b) => b.vertical));
  if (hasVertical) {
    const vmode = await ev(`(() => {
      const b = Array.from(document.querySelectorAll('.ocr-box')).find(x => x.style.writingMode && x.style.writingMode.includes('vertical'));
      return b ? getComputedStyle(b).writingMode : 'none';
    })()`);
    check("vertical blocks use vertical writing mode", String(vmode).includes("vertical"), String(vmode));
  } else {
    console.log("SKIP  no vertical blocks in this .mokuro to test");
  }

  chrome.kill();
  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
