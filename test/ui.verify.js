// Headless browser verification for MANGA.CAB.
//
// Checks the reader renders pages in order, scrolls infinitely, serves
// page images, handles the OCR overlay toggle, and that the library
// drawer + upload UI are usable on a phone viewport.
//
// Run: node test/ui.verify.js

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8790;
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
    pass++;
  } else {
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.on("open", res);
      ws.on("error", rej);
    });
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=9333`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:9333/json/version")).json();
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
    const r = await cdp.send(
      "Runtime.evaluate",
      { expression: expr, returnByValue: true, awaitPromise: true },
      sessionId
    );
    if (r.exceptionDetails) {
      return "ERR " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  // ── Phone viewport ────────────────────────────────────────
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 412, height: 915, deviceScaleFactor: 2, mobile: true,
  }, sessionId);

  await cdp.send("Page.navigate", { url: BASE }, sessionId);
  await sleep(2500);

  console.log("── shell ──");
  check("page loads", (await ev("document.title")) === "MANGA.CAB — Webtoon Reader", String(await ev("document.title")));
  // The shelf is now a full screen, not a drawer.
  check("the shelf is the starting screen",
    await ev("document.getElementById('app').classList.contains('view-library')"));
  check("the shelf is visible",
    await ev("getComputedStyle(document.getElementById('library')).display !== 'none'"));
  check("the reader screen starts hidden",
    await ev("getComputedStyle(document.getElementById('readerScreen')).display === 'none'"));
  check("dropzone present", await ev("!!document.getElementById('dropZone')"));
  check("folder picker present", await ev("!!document.getElementById('folderInput') && document.getElementById('folderInput').hasAttribute('webkitdirectory')"));

  // ── Upload via the API, then open the volume ─────────────
  console.log("");
  console.log("── upload ──");
  const volumeId = await ev(`(async () => {
    const files = [];
    for (let i = 1; i <= 6; i++) {
      const blob = await fetch('/api/health').then(r => r.blob());
      files.push(blob);
    }
    return null;
  })()`);

  // Use curl-equivalent upload through the page's own fetch.
  const uploaded = await ev(`(async () => {
    const fd = new FormData();
    const names = [];
    for (let i = 1; i <= 6; i++) {
      const c = document.createElement('canvas');
      c.width = 400; c.height = 600;
      const g = c.getContext('2d');
      g.fillStyle = '#' + ((i * 40).toString(16).padStart(2,'0')).repeat(3);
      g.fillRect(0,0,400,600);
      g.fillStyle = '#fff'; g.font = 'bold 90px sans-serif';
      g.fillText(String(i), 150, 330);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
      fd.append('files', blob, 'page' + String(i).padStart(3,'0') + '.jpg');
      names.push('page' + String(i).padStart(3,'0') + '.jpg');
    }
    fd.append('title', 'Browser Upload Test');
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    return data.volume ? data.volume.id : ('ERR ' + JSON.stringify(data));
  })()`);

  check("folder upload via fetch succeeds", typeof uploaded === "string" && uploaded.startsWith("m"), String(uploaded));

  await ev(`(async () => {
    await window.openVolume('${uploaded}');
    return true;
  })()`).catch(() => {});
  await sleep(1800);

  console.log("");
  console.log("── reader ──");
  const pageCount = await ev("document.querySelectorAll('.page').length");
  check("pages rendered", pageCount === 6, `${pageCount} pages`);

  const srcs = await ev("Array.from(document.querySelectorAll('.page img')).map(i => i.getAttribute('src'))");
  check("page srcs are sequential", Array.isArray(srcs) && srcs[0].endsWith("/001.jpg") && srcs[5].endsWith("/006.jpg"), String(srcs && srcs[0]));

  const title = await ev("document.getElementById('volumeTitle').textContent");
  check("title shown", title === "Browser Upload Test", String(title));

  const indicator = await ev("document.getElementById('pageIndicator').textContent");
  check("page indicator populated", /\d+\s*\/\s*6/.test(String(indicator)), String(indicator));

  // Images actually load
  const loaded = await ev(`(async () => {
    const imgs = Array.from(document.querySelectorAll('.page img'));
    await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.onload = r; i.onerror = r; })));
    return imgs.filter(i => i.naturalWidth > 0).length;
  })()`);
  check("all page images load", loaded === 6, `${loaded}/6 loaded`);

  // Scroll works
  const scrolled = await ev(`(async () => {
    const r = document.getElementById('reader');
    const before = r.scrollTop;
    r.scrollTop = 600;
    await new Promise(r2 => setTimeout(r2, 250));
    return { before, after: r.scrollTop, max: r.scrollHeight - r.clientHeight };
  })()`);
  check("reader scrolls vertically", scrolled.after > scrolled.before, `${scrolled.before} -> ${scrolled.after} (max ${scrolled.max})`);

  const railWidth = await ev("document.getElementById('railFill').style.width");
  check("progress rail tracks scroll", /%/.test(String(railWidth)) && railWidth !== "0%", String(railWidth));

  // ── OCR layer ────────────────────────────────────────────
  console.log("");
  console.log("── ocr layer ──");
  // The top-bar button cycles the display modes (off → tap → read).
  await ev("window.setOcrMode('tap')");
  await sleep(500);
  check("ocr toggle pressed", (await ev("document.getElementById('ocrToggle').getAttribute('aria-pressed')")) === "true");
  check("ocr layer element per page", (await ev("document.querySelectorAll('.ocr-layer').length")) === 6);
  check("pages marked ocr-active", (await ev("document.querySelectorAll('.page.ocr-active').length")) === 6);

  // Attach a synthetic .mokuro and confirm the overlay boxes render.
  const ocrBoxes = await ev(`(async () => {
    const vid = '${uploaded}';
    const mk = (txt) => ({ box: [20, 100, 380, 180], font_size: 40, vertical: false, lines: [txt] });
    const doc = { pages: Array.from({length: 6}, (_, i) => ({ img_path: '00' + (i+1) + '.jpg', img_width: 400, img_height: 600, blocks: [mk('测试第' + (i+1) + '页')] })) };
    const file = new File([JSON.stringify(doc)], 'v.mokuro', {type: 'application/json'});
    try {
      const data = await window.attachMokuro(vid, file);
      return data;
    } catch (e) {
      return { error: String(e) };
    }
  })()`);
  check("mokuro attached to volume", ocrBoxes && ocrBoxes.ok === true, JSON.stringify(ocrBoxes));

  await ev("window.setOcr(false); window.setOcr(true)");
  await sleep(700);
  const boxCount = await ev("document.querySelectorAll('.ocr-box').length");
  check("ocr boxes rendered", boxCount === 6, `${boxCount} boxes`);

  const boxText = await ev("document.querySelector('.ocr-box')?.textContent || ''");
  check("ocr box carries the text", String(boxText).includes("测试"), String(boxText));

  const selectable = await ev(`(() => {
    const b = document.querySelector('.ocr-box');
    if (!b) return false;
    const cs = getComputedStyle(b);
    return cs.userSelect === 'text' || cs.webkitUserSelect === 'text';
  })()`);
  check("ocr text is selectable", selectable === true);

  // The overlay must actually capture a selection when the user drags.
  const selected = await ev(`(() => {
    const b = document.querySelector('.ocr-box');
    if (!b) return 'no box';
    const range = document.createRange();
    range.selectNodeContents(b);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return sel.toString();
  })()`);
  check("ocr text can be selected and read", String(selected).includes("测试"), JSON.stringify(selected));

  const layerOn = await ev("document.querySelector('.ocr-layer').classList.contains('on')");
  check("ocr layer is interactive when on", layerOn === true);

  const imgOpacity = await ev("getComputedStyle(document.querySelector('.page.ocr-active img')).opacity");
  check("image dims slightly under the text layer", parseFloat(imgOpacity) < 1, `opacity ${imgOpacity}`);

  // ── Responsive ───────────────────────────────────────────
  console.log("");
  console.log("── responsive ──");
  const overflow = await ev("document.documentElement.scrollWidth - window.innerWidth");
  check("no horizontal overflow", overflow <= 1, `${overflow}px`);

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 375, height: 667, deviceScaleFactor: 2, mobile: true,
  }, sessionId);
  await sleep(600);
  const overflow2 = await ev("document.documentElement.scrollWidth - window.innerWidth");
  check("no horizontal overflow on iPhone SE", overflow2 <= 1, `${overflow2}px`);

  const tap = await ev(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const small = btns.filter(b => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && (r.height < 32 || r.width < 32);
    });
    return { total: btns.length, small: small.length, names: small.map(b => b.className + ':' + Math.round(b.getBoundingClientRect().height)) };
  })()`);
  check("tap targets >= 32px", tap.small === 0, JSON.stringify(tap));

  // ── Errors ───────────────────────────────────────────────
  console.log("");
  check("no JS exceptions", errors.length === 0, errors.slice(0, 3).join(" | "));

  chrome.kill();
  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
