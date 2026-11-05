// ═══════════════════════════════════════════════════════════════
// Filename encoding helpers.
//
// Multipart filenames travel in the request headers, which are latin-1
// by spec. Busboy (under multer) therefore hands us UTF-8 bytes decoded
// as latin-1, which mangles any non-ASCII name — a Chinese title would
// arrive as "é¢\x84å\x8a_91dbdb" instead of "包子漫畫".
//
// The fix is to re-interpret the latin-1 string as UTF-8 bytes. We only
// do it when the result is valid UTF-8 *and* differs from the input,
// so plain ASCII names are left untouched.
// ═══════════════════════════════════════════════════════════════

/**
 * Repair a latin-1-mangled UTF-8 filename.
 * Returns the original string unchanged if it is not mangled.
 */
export function fixFilename(name) {
  if (!name) return name;

  // Pure ASCII is always correct already.
  // eslint-disable-next-line no-control-regex
  if (!/[-ÿ]/.test(name)) return name;

  try {
    const bytes = Buffer.from(name, "latin1");
    const decoded = bytes.toString("utf8");

    // Round-trip check: if the decoded text does not re-encode to the
    // same bytes, it was not valid UTF-8 in the first place.
    if (!Buffer.from(decoded, "utf8").equals(bytes)) return name;

    return decoded;
  } catch {
    return name;
  }
}

/**
 * Apply the repair to a multer file object.
 */
export function fixFile(f) {
  if (!f) return f;
  if (f.originalname) f.originalname = fixFilename(f.originalname);
  if (f.filename) f.filename = fixFilename(f.filename);
  return f;
}

/**
 * Repair a list of multer file objects in place.
 */
export function fixFiles(files) {
  if (!files) return files;
  const list = Array.isArray(files) ? files : [files];
  for (const f of list) fixFile(f);
  return files;
}
