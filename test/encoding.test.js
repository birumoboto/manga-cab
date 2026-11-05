// Tests the multipart filename encoding repair.
//
// Multipart headers are latin-1, so a UTF-8 filename arrives mangled.
// fixFilename() must recover the original without touching ASCII names.
//
// Run: node test/encoding.test.js

import { fixFilename, fixFiles } from "../server/encoding.js";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`); pass++; }
  else { console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
};

/** Simulate what busboy does: take a UTF-8 string, encode to bytes, decode as latin1. */
function mangle(utf8) {
  return Buffer.from(utf8, "utf8").toString("latin1");
}

// ── ASCII names are untouched ──────────────────────────────────
check("plain ascii unchanged", fixFilename("page001.jpg") === "page001.jpg");
check("ascii with spaces unchanged", fixFilename("my chapter 01.jpg") === "my chapter 01.jpg");
check("empty string safe", fixFilename("") === "");
check("undefined safe", fixFilename(undefined) === undefined);

// ── Mangled UTF-8 is recovered ────────────────────────────────
const cases = [
  "包子漫畫",
  "第1話",
  "中文標題",
  " comics ",
  "日本語",
  "Ünïcödé",
];

for (const original of cases) {
  const mangled = mangle(original);
  const fixed = fixFilename(mangled);
  check(`recovers "${original}"`, fixed === original, `got "${fixed}"`);
}

// ── A genuinely latin-1 name is left alone ────────────────────
const realLatin1 = "café.jpg";
check("real latin-1 left alone", fixFilename(realLatin1) === realLatin1, fixFilename(realLatin1));

// ── A byte string that is not valid UTF-8 is left alone ───────
const invalid = Buffer.from([0xff, 0xfe, 0x41]).toString("latin1");
check("invalid utf-8 left alone", fixFilename(invalid) === invalid);

// ── multer file objects ───────────────────────────────────────
const f = { originalname: mangle("包子漫畫"), filename: mangle("包子漫畫") };
fixFiles([f]);
check("multer file repaired", f.originalname === "包子漫畫", f.originalname);
check("multer filename repaired", f.filename === "包子漫畫", f.filename);

const single = { originalname: mangle("第1話") };
fixFiles(single);
check("single file object repaired", single.originalname === "第1話", single.originalname);

console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
