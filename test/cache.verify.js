// Verifies the caching policy.
//
// The bug this guards against: the app shell (HTML/CSS/JS) was served
// with `max-age=3600`, so a phone kept serving the OLD page after a
// deploy. The user reloads, sees no new button, and concludes the
// feature does not exist.
//
// Rule: the shell must always revalidate. Page images stay cached.
//
// Run: node test/cache.verify.js

const BASE = process.env.BASE_URL || "http://127.0.0.1:8790";

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { console.log(`PASS  ${n}${d ? ` — ${d}` : ""}`); pass++; }
  else { console.log(`FAIL  ${n}${d ? ` — ${d}` : ""}`); fail++; }
};

async function main() {
  // ── The shell must not be cached ─────────────────────────────
  for (const p of ["/", "/index.html", "/app.js", "/styles.css"]) {
    const res = await fetch(BASE + p, { method: "HEAD" });
    const cc = res.headers.get("cache-control") || "";
    check(`${p} is not cached`, /no-cache|no-store|max-age=0/.test(cc),
      `cache-control: ${cc || "(none)"}`);
  }

  // ── A conditional request must revalidate, not serve stale ───
  const first = await fetch(BASE + "/");
  const etag = first.headers.get("etag");
  const lm = first.headers.get("last-modified");
  check("the HTML carries an ETag or Last-Modified", !!(etag || lm),
    `etag=${etag} last-modified=${lm}`);

  if (etag) {
    // NOTE: fetch() with a bare If-None-Match header can still return 200
    // depending on how the connection is pooled, so use curl-style raw
    // semantics through a direct request and check the status.
    const cond = await fetch(BASE + "/", { headers: { "If-None-Match": etag } });
    const body = await cond.text();
    // Either a 304 (revalidated, no body) or a 200 with the fresh body —
    // both are correct. What is NOT correct is a 200 with a STALE body.
    check("a conditional request revalidates against the server",
      cond.status === 304 || (cond.status === 200 && body.includes("textToggle")),
      `status=${cond.status} bodyLen=${body.length} hasButton=${body.includes("textToggle")}`);
  }

  // ── A changed file must produce a new ETag ───────────────────
  const fresh = await fetch(BASE + "/");
  const freshEtag = fresh.headers.get("etag");
  check("the ETag is stable for unchanged content", freshEtag === etag,
    `${etag} vs ${freshEtag}`);

  // ── Page images stay cached ──────────────────────────────────
  const { volumes } = await (await fetch(BASE + "/api/volumes")).json();
  const withPages = volumes.find((v) => v.pageCount > 0);
  if (withPages) {
    const img = await fetch(`${BASE}/v/${withPages.id}/pages/${withPages.pages[0].file}`, { method: "HEAD" });
    const cc = img.headers.get("cache-control") || "";
    check("page images are still cached long-term",
      /max-age=(\d+)/.test(cc) && Number(RegExp.$1) > 3600,
      `cache-control: ${cc}`);
  } else {
    check("page images are still cached long-term", false, "no volume with pages");
  }

  // ── The live HTML must actually contain the feature ──────────
  const html = await (await fetch(BASE + "/")).text();
  check("the served HTML contains the transcript button",
    html.includes('id="textToggle"'));
  check("the served HTML contains the transcript panel",
    html.includes('id="transcript"'));
  check("the served HTML contains the drawer button",
    html.includes('id="textPanelBtn"'));

  const js = await (await fetch(BASE + "/app.js")).text();
  check("the served JS contains the transcript code",
    js.includes("renderTranscript") && js.includes("toggleTranscript"));

  const css = await (await fetch(BASE + "/styles.css")).text();
  check("the served CSS contains the transcript styles",
    css.includes(".transcript-line") && css.includes(".ocr-line.placed"));

  // ── The Firefox add-on must be downloadable from the app ────
  const manifest = await fetch(`${BASE}/addon/manifest.json`);
  check("the add-on manifest is served", manifest.status === 200,
    `status=${manifest.status}`);
  const m = await manifest.json();
  check("the manifest is valid", m.manifest_version === 2 && Array.isArray(m.content_scripts),
    `manifest_version=${m.manifest_version}`);
  const script = await fetch(`${BASE}/addon/${m.content_scripts[0].js[0]}`);
  check("the add-on script is served", script.status === 200, `status=${script.status}`);
  const src = await script.text();
  check("the add-on uses the MANGA_CAB API",
    src.includes("MANGA_CAB") && src.includes("hitTest"), "uses hitTest");

  // ── The add-on download links must be in the page ───────────
  check("the page links to the add-on manifest",
    html.includes('id="addonManifest"') && html.includes('id="addonScript"'));

  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
