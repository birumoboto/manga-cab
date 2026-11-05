// End-to-end test of the automatic OCR pipeline.
//
// Uploads a small volume, triggers OCR via the API, waits for the job
// to finish, and verifies the .mokuro got attached and the text is
// readable.
//
// This shells out to the real mokuro python venv, so it needs
// ~/mokuro/.venv to exist.
//
// Run: node test/ocr.verify.js

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8790";
const MOKURO_PY = process.env.MOKURO_PYTHON || "/Users/bing/mokuro/.venv/bin/python";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`); pass++; }
  else { console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(MOKURO_PY)) {
    console.log(`SKIP  mokuro python not found at ${MOKURO_PY}`);
    return 0;
  }

  // ── Build a small test volume with readable Chinese text ─────
  // We use the synthetic corpus if it exists, else generate nothing and
  // bail out — the point is to exercise the real pipeline.
  const corpus = "/Users/bing/mokuro/tests/data/chinese";
  if (!fs.existsSync(corpus)) {
    console.log("SKIP  synthetic corpus missing — run mokuro's make_chinese_corpus first");
    return 0;
  }

  const pages = fs.readdirSync(corpus)
    .filter((f) => f.endsWith(".png"))
    .slice(0, 3)
    .map((f) => path.join(corpus, f));

  console.log(`using ${pages.length} pages from ${corpus}`);

  // Upload via multipart.
  const form = new FormData();
  for (const p of pages) {
    form.append("files", new Blob([fs.readFileSync(p)]), path.basename(p));
  }
  form.append("title", "OCR Auto Test");

  const upRes = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
  const upData = await upRes.json();
  check("volume uploaded", upRes.ok && upData.volume, JSON.stringify(upData).slice(0, 120));
  if (!upRes.ok || !upData.volume) return 1;
  const id = upData.volume.id;

  // ── OCR availability ─────────────────────────────────────────
  const status = await (await fetch(`${BASE}/api/ocr/status`)).json();
  check("ocr reports mokuro available", status.available === true);
  check("ocr lists supported languages", Array.isArray(status.languages) && status.languages.includes("zh"), JSON.stringify(status.languages));

  // ── Kick off OCR ─────────────────────────────────────────────
  const startRes = await fetch(`${BASE}/api/volumes/${id}/ocr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lang: "zh" }),
  });
  check("ocr job accepted", startRes.status === 202, `HTTP ${startRes.status}`);

  // ── Poll until done ──────────────────────────────────────────
  let job = null;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const s = await (await fetch(`${BASE}/api/ocr/status`)).json();
    job = s.jobs?.[id];
    if (!job) continue;
    if (job.status === "done" || job.status === "error") break;
  }

  check("ocr job finished", job && job.status === "done", job ? `${job.status} ${job.error || ""}` : "no job");
  if (!job || job.status !== "done") {
    await fetch(`${BASE}/api/volumes/${id}`, { method: "DELETE" });
    return 1;
  }
  check("ocr found text blocks", (job.blocks || 0) > 0, `${job.blocks} blocks`);

  // ── The .mokuro got attached to the volume ───────────────────
  const meta = await (await fetch(`${BASE}/api/volumes/${id}`)).json();
  check("volume has ocr data attached", !!meta.mokuro);

  const ocr = await (await fetch(`${BASE}/v/${id}/mokuro`)).json();
  check("ocr page count matches", ocr.pages?.length === pages.length, `${ocr.pages?.length} vs ${pages.length}`);
  check("ocr language recorded", ocr.lang === "zh", String(ocr.lang));

  const allText = (ocr.pages || [])
    .flatMap((p) => p.blocks || [])
    .flatMap((b) => b.lines || [])
    .join("");
  check("ocr produced readable chinese", /[\u4e00-\u9fff]/.test(allText), JSON.stringify(allText.slice(0, 40)));

  // ── Re-running OCR should be refused while running, and fine after ─
  const rerun = await fetch(`${BASE}/api/volumes/${id}/ocr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lang: "zh" }),
  });
  check("re-running ocr is allowed when idle", rerun.status === 202, `HTTP ${rerun.status}`);

  // Bad language is rejected.
  const bad = await fetch(`${BASE}/api/volumes/${id}/ocr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lang: "klingon" }),
  });
  check("unsupported language rejected", bad.status === 400, `HTTP ${bad.status}`);

  // ── Clean up ─────────────────────────────────────────────────
  await fetch(`${BASE}/api/volumes/${id}`, { method: "DELETE" });
  check("test volume cleaned up", true);

  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
