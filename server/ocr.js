// ═══════════════════════════════════════════════════════════════
// OCR pipeline — runs mokuro over a volume's pages and attaches the
// resulting .mokuro to it.
//
// mokuro lives in a separate Python venv (~/mokuro/.venv) because it
// needs torch + manga-ocr + cnocr, which we do not want inside the
// Node server. This module shells out to that venv.
//
// Flow:
//   1. build a staging dir of symlinks to the volume's pages
//   2. run `python -m mokuro <staging> --lang zh --legacy_html False`
//   3. read the produced <staging>.mokuro JSON
//   4. attach it to the volume
// ═══════════════════════════════════════════════════════════════

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";

// The mokuro checkout and its Python venv. Both are overridable so the
// reader can run from a checkout anywhere.
const HOME = process.env.HOME || os.homedir();
const MOKURO_DIR = process.env.MOKURO_DIR || `${HOME}/mokuro`;
const MOKURO_PYTHON = path.join(MOKURO_DIR, ".venv", "bin", "python");
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 30 * 60 * 1000);

/** Languages mokuro supports for us. */
export const LANGUAGES = ["ja", "zh"];

/**
 * Recognizer backends, and what each is good at.
 *
 * cnocr  the default. Fast, and on real artwork it finds the text that
 *        is actually there: on the real webtoon's vertical blocks it
 *        read the single large glyph (福 / 茶 / 露) where PP-OCRv5 read
 *        several characters out of the panel artwork around it.
 * paddle PP-OCRv5. Slower, but reads CLEAN vertical columns exactly —
 *        on columns with known text it got 7/7 exact and 100% character
 *        accuracy, against CnOCR's 5/7 and 93.3%. Worth switching to for
 *        pages whose text is well separated from the artwork.
 * manga-ocr  the default for Japanese.
 */
export const RECOGNIZERS = [
  { id: "cnocr", label: "CnOCR (fast, default)" },
  { id: "paddle", label: "PP-OCRv5 (clean vertical columns)" },
];

/**
 * Run mokuro OCR over a directory of images.
 * Returns the parsed .mokuro object.
 */
export function runMokuro(imageDir, { lang = "zh", recognizer = "", timeoutMs = OCR_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(MOKURO_PYTHON)) {
      return reject(new Error(`mokuro python not found at ${MOKURO_PYTHON}`));
    }

    const args = [
      "-m", "mokuro",
      imageDir,
      "--lang", lang,
      "--disable_confirmation",
      "--legacy_html", "False",
    ];
    if (recognizer) args.push("--recognizer", recognizer);

    const child = spawn(MOKURO_PYTHON, args, {
      cwd: MOKURO_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to run mokuro: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`mokuro timed out after ${Math.round(timeoutMs / 1000)}s`));
      }
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-6).join("\n");
        return reject(new Error(`mokuro exited ${code}\n${tail}`));
      }

      // mokuro writes <input-dir>.mokuro next to the input directory.
      const expected = `${imageDir}.mokuro`;
      if (!fs.existsSync(expected)) {
        return reject(new Error(`mokuro produced no output at ${expected}`));
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(expected, "utf8"));
        resolve(parsed);
      } catch (e) {
        reject(new Error(`could not parse mokuro output: ${e.message}`));
      }
    });
  });
}

/**
 * OCR a volume's pages in place.
 *
 * The volume's pages live under data/_volumes/<id>/pages. mokuro expects a
 * directory of images and writes <dir>.mokuro alongside it, so we point it
 * at the pages directory directly and clean up afterwards.
 */
export async function ocrVolume(store, id, { lang = "zh", recognizer = "" } = {}) {
  const meta = await store.read(id);
  if (!meta) throw new Error("volume not found");
  if (!meta.pageCount) throw new Error("volume has no pages");

  const pagesDir = path.join(store.volumeDir(id), "pages");
  if (!fs.existsSync(pagesDir)) throw new Error("volume pages are missing");

  // mokuro writes <pagesDir>.mokuro — that is data/_volumes/<id>/pages.mokuro,
  // which is a valid sibling of the pages dir and easy to clean up.
  const outputPath = `${pagesDir}.mokuro`;
  const ocrCacheDir = path.join(store.volumeDir(id), "_ocr");

  try {
    const result = await runMokuro(pagesDir, { lang, recognizer });
    return { meta, result, outputPath };
  } catch (err) {
    // mokuro may also have written a per-page cache dir; leave it, it makes
    // re-runs much faster.
    void ocrCacheDir;
    throw err;
  }
}

/** Remove a generated .mokuro file if present. */
export async function cleanupOutput(outputPath) {
  try {
    await fsp.rm(outputPath, { force: true });
  } catch {
    // best effort
  }
}

/**
 * Build a staging directory of symlinks to the real pages.
 *
 * Used when we want to run OCR without writing into the volume's own
 * directory (keeps the volume layout clean).
 */
export async function stagePages(store, id) {
  const meta = await store.read(id);
  if (!meta) throw new Error("volume not found");

  const pagesDir = path.join(store.volumeDir(id), "pages");
  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), "mangacab-ocr-"));

  for (const page of meta.pages) {
    const src = path.join(pagesDir, page.file);
    try {
      await fsp.symlink(src, path.join(stage, page.file));
    } catch {
      // Fall back to copying if symlinks are not permitted.
      await fsp.copyFile(src, path.join(stage, page.file));
    }
  }

  return { stage, meta };
}

export { MOKURO_DIR, MOKURO_PYTHON };
