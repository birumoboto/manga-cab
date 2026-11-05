// ═══════════════════════════════════════════════════════════════
// Volume store — manages uploaded manga/comic volumes on disk.
//
// Layout on disk:
//   data/<volumeId>/
//     volume.json      metadata (title, page list, created, source)
//     pages/001.jpg    page images, in reading order
//
// Pages are stored with zero-padded names so a plain lexical sort
// matches reading order, and the original filename is preserved in
// volume.json for display.
// ═══════════════════════════════════════════════════════════════

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".bmp"]);

/** Natural sort: "page2.jpg" before "page10.jpg". */
export function naturalCompare(a, b) {
  const ax = [];
  const bx = [];
  String(a).replace(/(\d+)|(\D+)/g, (_, d, s) => {
    (d ? ax : bx).push(d ? Number(d) : s);
    return "";
  });
  // Rebuild with numbers compared numerically, strings lexically.
  const as = String(a).match(/(\d+)|(\D+)/g) || [];
  const bs = String(b).match(/(\d+)|(\D+)/g) || [];
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function isImageFile(name) {
  return IMAGE_EXT.has(path.extname(name).toLowerCase());
}

export class VolumeStore {
  constructor(root) {
    this.root = root;
    this.pagesDir = path.join(root, "_pages");
    this.volumesDir = path.join(root, "_volumes");
    fs.mkdirSync(this.pagesDir, { recursive: true });
    fs.mkdirSync(this.volumesDir, { recursive: true });
  }

  volumeDir(id) {
    return path.join(this.volumesDir, id);
  }

  /** List every stored volume, newest first. */
  async list() {
    const entries = await fsp.readdir(this.volumesDir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const meta = await this.read(e.name);
      if (meta) out.push(meta);
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }

  async read(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    try {
      const raw = await fsp.readFile(path.join(this.volumeDir(id), "volume.json"), "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Create a volume from a list of { buffer, filename } entries.
   * Returns the stored volume metadata.
   */
  async create({ title, files, source = "upload", mokuro = null }) {
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
    const dir = this.volumeDir(id);
    const pagesDir = path.join(dir, "pages");
    await fsp.mkdir(pagesDir, { recursive: true });

    // Accept either `filename` or multer's `originalname`.
    const images = files
      .map((f) => ({ ...f, filename: f.filename || f.originalname || "" }))
      .filter((f) => isImageFile(f.filename))
      .sort((a, b) => naturalCompare(a.filename, b.filename));

    const pages = [];
    const digits = String(Math.max(images.length, 1)).length;
    const pad = Math.max(3, digits);

    for (let i = 0; i < images.length; i++) {
      const stored = `${String(i + 1).padStart(pad, "0")}${path.extname(images[i].filename).toLowerCase() || ".jpg"}`;
      await fsp.writeFile(path.join(pagesDir, stored), images[i].buffer);
      pages.push({
        index: i,
        file: stored,
        original: path.basename(images[i].filename),
        size: images[i].buffer.length,
      });
    }

    const meta = {
      id,
      title: title || "Untitled",
      source,
      createdAt: Date.now(),
      pageCount: pages.length,
      pages,
      // OCR results, if a matching .mokuro file was uploaded alongside
      mokuro: mokuro || null,
    };

    await fsp.writeFile(
      path.join(dir, "volume.json"),
      JSON.stringify(meta, null, 2),
      "utf8"
    );

    return meta;
  }

  async remove(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return false;
    const dir = this.volumeDir(id);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Absolute path of a page file, or null if out of bounds. */
  pagePath(id, file) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    if (!/^[A-Za-z0-9_.-]+$/.test(file) || file.includes("..")) return null;
    const p = path.join(this.volumeDir(id), "pages", file);
    return p;
  }
}
