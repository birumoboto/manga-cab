// ═══════════════════════════════════════════════════════════════
// Zip / cbz extraction.
//
// Komikku archives chapters as .cbz, which is just a zip of page images.
// We extract the image entries in natural filename order so pages land
// in reading order.
// ═══════════════════════════════════════════════════════════════

import yauzl from "yauzl";
import { naturalCompare, isImageFile } from "./store.js";

/**
 * Extract image entries from a zip buffer.
 * Returns [{ buffer, filename }] sorted in natural reading order.
 */
export function extractZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);

      const entries = [];
      const chunks = [];

      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          // Directory entry
          zipfile.readEntry();
          return;
        }
        const name = entry.fileName.replace(/\\/g, "/");
        if (!isImageFile(name)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) {
            zipfile.readEntry();
            return;
          }
          const parts = [];
          stream.on("data", (d) => parts.push(d));
          stream.on("error", () => zipfile.readEntry());
          stream.on("end", () => {
            entries.push({ name, buffer: Buffer.concat(parts) });
            zipfile.readEntry();
          });
        });
      });

      zipfile.on("end", () => {
        entries.sort((a, b) => naturalCompare(baseName(a.name), baseName(b.name)));
        resolve(
          entries.map((e) => ({
            filename: baseName(e.name),
            buffer: e.buffer,
          }))
        );
      });

      zipfile.on("error", reject);
    });
  });
}

function baseName(p) {
  const parts = p.split("/");
  return parts[parts.length - 1];
}
