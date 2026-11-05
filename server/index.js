// ═══════════════════════════════════════════════════════════════
// MANGA.CAB — webtoon reader server
//
// Endpoints:
//   GET  /                      the reader app
//   GET  /api/volumes           list uploaded volumes
//   POST /api/upload            multipart upload (files[] + title)
//   POST /api/upload/zip        upload a .zip/.cbz archive
//   DELETE /api/volumes/:id     remove a volume
//   GET  /api/volumes/:id       volume metadata
//   GET  /v/:id/pages/:file     serve a page image
//   GET  /v/:id/mokuro          serve the .mokuro OCR JSON
// ═══════════════════════════════════════════════════════════════

import express from "express";
import multer from "multer";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { VolumeStore, isImageFile, naturalCompare } from "./store.js";
import { extractZip } from "./unzip.js";
import { ocrVolume, LANGUAGES, RECOGNIZERS, MOKURO_PYTHON } from "./ocr.js";
import { fixFiles, fixFilename } from "./encoding.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.MANGA_DATA_DIR || path.join(ROOT, "data");
const PORT = Number(process.env.PORT || 8790);

const store = new VolumeStore(DATA_DIR);

const app = express();
app.use(express.json({ limit: "10mb" }));

// Static assets.
//
// The HTML, CSS and JS are the app shell and change with every deploy.
// Caching them means a phone keeps serving a stale shell — the user
// reloads, sees the old UI, and concludes the new feature "does not
// exist". Page IMAGES are immutable (their filename never changes) and
// are cached separately, further down, with a one-year TTL.
//
// So: the shell is always revalidated, the artwork stays cached.
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    const name = path.basename(filePath);
    if (/\.(html|css|js|json|svg|ico)$/i.test(name)) {
      // No caching for the shell: always ask the server.
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    } else {
      res.setHeader("Cache-Control", "public, max-age=3600");
    }
  },
}));

// The Firefox add-on, served so it can be downloaded from the app
// itself rather than having to find the files on the server.
app.use("/addon", express.static(path.join(ROOT, "addon"), {
  etag: true,
  lastModified: true,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
  },
}));

// ── Upload handling ────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 64 * 1024 * 1024, // 64 MB per file
    files: 2000,
  },
});

// ── API: list volumes ──────────────────────────────────────────
app.get("/api/volumes", async (req, res) => {
  try {
    const volumes = await store.list();
    res.json({ volumes });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── API: single volume ─────────────────────────────────────────
app.get("/api/volumes/:id", async (req, res) => {
  const meta = await store.read(req.params.id);
  if (!meta) return res.status(404).json({ error: "not found" });
  res.json(meta);
});

// ── API: delete volume ─────────────────────────────────────────
app.delete("/api/volumes/:id", async (req, res) => {
  const ok = await store.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

// ── API: upload a folder of images ─────────────────────────────
app.post("/api/upload", upload.array("files", 2000), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: "no files uploaded" });
    }
    // Multipart filenames arrive latin-1 mangled — repair before use.
    fixFiles(files);
    const title = fixFilename(req.body?.title) || inferTitle(files);
    const meta = await store.create({ title, files, source: "upload" });
    res.json({ volume: meta });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── API: upload a zip / cbz archive ────────────────────────────
app.post("/api/upload/zip", upload.single("archive"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no archive uploaded" });
    const extracted = await extractZip(req.file.buffer);
    if (!extracted.length) {
      return res.status(400).json({ error: "archive contained no images" });
    }
    const title = fixFilename(req.body?.title) || fixFilename(stripExt(req.file.originalname));
    const meta = await store.create({
      title,
      files: extracted,
      source: "zip",
    });
    res.json({ volume: meta });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── API: attach a .mokuro OCR file to an existing volume ───────
app.post("/api/volumes/:id/mokuro", upload.single("mokuro"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no mokuro file uploaded" });
    const meta = await store.read(req.params.id);
    if (!meta) return res.status(404).json({ error: "volume not found" });
    let parsed;
    try {
      parsed = JSON.parse(req.file.buffer.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "invalid JSON" });
    }
    meta.mokuro = parsed;
    await fsp.writeFile(
      path.join(store.volumeDir(meta.id), "volume.json"),
      JSON.stringify(meta, null, 2),
      "utf8"
    );
    res.json({ ok: true, pages: parsed.pages?.length || 0 });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Serve page images ──────────────────────────────────────────
app.get("/v/:id/pages/:file", async (req, res) => {
  const p = store.pagePath(req.params.id, req.params.file);
  if (!p) return res.status(400).end();
  try {
    const stat = await fsp.stat(p);
    res.setHeader("Content-Type", mimeFor(p));
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    fs.createReadStream(p).pipe(res);
  } catch {
    res.status(404).end();
  }
});

// ── OCR jobs ───────────────────────────────────────────────────
// OCR takes minutes on a long volume, so it runs in the background and
// the client polls for status.
const ocrJobs = new Map();

app.get("/api/ocr/status", (req, res) => {
  res.json({
    available: fs.existsSync(MOKURO_PYTHON),
    languages: LANGUAGES,
    recognizers: RECOGNIZERS,
    jobs: Object.fromEntries(ocrJobs),
  });
});

app.post("/api/volumes/:id/ocr", async (req, res) => {
  const id = req.params.id;
  const lang = String(req.body?.lang || "zh").toLowerCase();
  const recognizer = String(req.body?.recognizer || "").toLowerCase();

  if (!LANGUAGES.includes(lang)) {
    return res.status(400).json({ error: `unsupported language: ${lang}` });
  }
  if (recognizer && !RECOGNIZERS.some((r) => r.id === recognizer)) {
    return res.status(400).json({ error: `unsupported recognizer: ${recognizer}` });
  }
  if (!fs.existsSync(MOKURO_PYTHON)) {
    return res.status(503).json({ error: "mokuro is not installed on this machine" });
  }

  const meta = await store.read(id);
  if (!meta) return res.status(404).json({ error: "volume not found" });
  if (!meta.pageCount) return res.status(400).json({ error: "volume has no pages" });

  // One job per volume at a time.
  const existing = ocrJobs.get(id);
  if (existing && (existing.status === "running" || existing.status === "queued")) {
    return res.status(409).json({ error: "OCR already running for this volume", job: existing });
  }

  const job = {
    id: `${id}-${Date.now()}`,
    volumeId: id,
    lang,
    recognizer: recognizer || "cnocr",
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    pages: meta.pageCount,
  };
  ocrJobs.set(id, job);

  res.status(202).json({ job });

  // Run detached from the request.
  (async () => {
    try {
      const { result } = await ocrVolume(store, id, { lang, recognizer });

      const updated = await store.read(id);
      updated.mokuro = result;
      await fsp.writeFile(
        path.join(store.volumeDir(id), "volume.json"),
        JSON.stringify(updated, null, 2),
        "utf8"
      );

      job.status = "done";
      job.finishedAt = Date.now();
      job.blocks = (result.pages || []).reduce((n, p) => n + (p.blocks?.length || 0), 0);
    } catch (err) {
      job.status = "error";
      job.error = String(err.message || err);
      job.finishedAt = Date.now();
    }
  })();
});

// ── Serve the OCR JSON ─────────────────────────────────────────
// Returns an empty document (not a 404) when a volume has no OCR data,
// so the client can poll without tripping network errors.
app.get("/v/:id/mokuro", async (req, res) => {
  const meta = await store.read(req.params.id);
  if (!meta?.mokuro) return res.json({ pages: [] });
  res.json(meta.mokuro);
});

// ── Favicon (inline so we never 404 on it) ────────────────────
app.get("/favicon.ico", (req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.send(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
      `<rect width="32" height="32" rx="6" fill="#ff4d6d"/>` +
      `<rect x="7" y="6" width="7" height="20" rx="2" fill="#fff"/>` +
      `<rect x="17" y="6" width="7" height="20" rx="2" fill="#fff" opacity=".7"/>` +
      `</svg>`
  );
});

// ── Health ─────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), volumes: undefined });
});

// ── Helpers ────────────────────────────────────────────────────
function inferTitle(files) {
  // Use the common parent directory name if the files came from a folder.
  const dirs = new Set();
  for (const f of files) {
    const p = (f.originalname || "").replace(/\\/g, "/");
    const parts = p.split("/");
    if (parts.length > 1) dirs.add(parts[parts.length - 2]);
  }
  if (dirs.size === 1) return [...dirs][0];
  return "Uploaded volume";
}

function stripExt(name) {
  return name.replace(/\.(zip|cbz)$/i, "");
}

const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};
function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || "application/octet-stream";
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`manga-reader listening on http://0.0.0.0:${PORT}`);
  console.log(`data dir: ${DATA_DIR}`);
});

export { app, store, naturalCompare, isImageFile };
