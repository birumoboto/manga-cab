# MANGA.CAB

A webtoon reader for the browser. Upload a folder of JPGs (or a `.zip`/`.cbz`)
and read it as a continuous vertical strip — the way webtoons are actually
meant to be read.

An OCR text layer makes the pages' dialogue **selectable and tappable**, so
you can copy, translate, or look it up. A ready-made Firefox add-on reads
a speech bubble out loud the moment you tap it.

## Live

```
https://bings-macbook-pro-2.tailb92b8e.ts.net/manga/
```

Tailnet-only (Tailscale Serve). Your phone needs to be on the same tailnet.

## The two screens

**SHELF** (the main menu) — your uploaded volumes as a list, plus the
dropzone for adding more. The app opens here.

**READER** — the webtoon itself, with a permanent **← SHELF** button in the
header. One tap gets you back to the menu, always. The phone's back gesture
works too.

## OCR display modes

The OCR sheet slides up from the bottom of the reader (the **OCR TEXT**
pill, bottom-right). It has three modes:

| Mode | What it does |
|---|---|
| **OFF** | No text layer. Clean artwork. |
| **TAP** | The text is invisible but tappable. Tap a speech bubble and it is revealed: the region's background turns white and the characters are drawn in dark ink so you can read them. |
| **READ** | The text is drawn on the page, so you can select it with a finger, copy it, or let an add-on read it. |

The top-bar text button cycles the modes. `O` toggles the layer on/off.

## Text zones

Every detected text block has a **zone** — the area of the artwork where
that text lives. In TAP mode the zone is invisible, but tapping inside it
reveals it:

- the region is painted **white**
- the characters are drawn in **dark ink**
- only one zone is revealed at a time
- tapping outside collapses it

The zone is measured from the *characters*, not the detected quad, because
the laid-out text is often wider than the ink box mokuro reports.

### Zone API for add-ons

```js
MANGA_CAB.getZones()          // every zone: {index, text, page, block, x, y, width, height, revealed}
MANGA_CAB.hitZone(x, y)        // the zone under a viewport point
MANGA_CAB.revealZone(index)    // reveal a zone by index
MANGA_CAB.collapseZones()      // hide every revealed zone
```

## The Firefox add-on

```
addon/manifest.json
addon/manga-cab-reader.js
```

Also downloadable from the app itself (the *For a Firefox add-on* section of
the OCR sheet).

To install:

1. Download both files (keep them in the same folder).
2. In Firefox: `about:debugging` → **This Firefox** → **Load Temporary Add-on**
3. Pick `manifest.json`.
4. Open MANGA.CAB and **tap a speech bubble**.

The add-on shows the tapped section in a panel at the bottom, with the
tapped character highlighted. Tap empty space to dismiss. `Esc` also
dismisses.

### The `MANGA_CAB` API

The page exposes a small, stable API for add-ons. From the browser console
(after opening a volume):

```js
MANGA_CAB.hitTest(x, y)     // the character element under a viewport point
MANGA_CAB.getCharacters()   // every character: {char, page, block, line, x, y, width, height}
MANGA_CAB.getLines()        // every OCR section (one speech bubble)
MANGA_CAB.getTranscript()   // the whole volume, grouped by page
MANGA_CAB.getMode()         // "off" | "tap" | "read"
MANGA_CAB.setMode("read")   // switch mode
MANGA_CAB.setOverlay(true)  // force the layer on/off
MANGA_CAB.getVolume()       // {id, title, pageCount}
```

Every character element also carries data attributes, so a plain CSS
selector works:

```css
.ocr-char[data-ocr-page="3"][data-ocr-line="1"]
```

> **Why `hitTest` and not `elementFromPoint`?**
> In TAP mode the overlay is `pointer-events: none` — deliberately, so that
> dragging over the artwork scrolls the page instead of selecting text.
> That means `document.elementFromPoint()` returns the artwork, not the
> text. `MANGA_CAB.hitTest()` does the hit-test properly against the
> character rects. In READ mode the layer takes pointer events and
> `elementFromPoint()` works normally.

## Features

- **Folder upload** — drag a folder of images onto the dropzone, or use
  *Choose Folder*. Relative paths are preserved so the folder name becomes
  the volume title.
- **Archive upload** — `.zip` and `.cbz` work too, which is what Komikku /
  Tachiyomi / Mihon produce.
- **Natural page ordering** — `page2.jpg` sorts before `page10.jpg`, and
  `ch1_p3` before `ch1_p20`.
- **Infinite vertical scroll** — pages load lazily, with a progress rail and
  a page indicator.
- **Automatic OCR** — runs the local mokuro Python environment over the
  pages in a background job. No cloud API, no key.
- **OCR transcript** — every detected section on its own line, grouped by
  page, as real selectable text.
- **Character-level selection** — every character is its own element, so you
  can select or tap one character at a time.
- **Mobile-first** — safe-area insets, ≥40px tap targets, no horizontal
  overflow down to 360px wide.
- **Keyboard** — `←`/`→` scroll, `Home`/`End` jump, `O` OCR, `T` transcript,
  `B` back to shelf, `Esc` backs out one layer at a time.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/volumes` | List uploaded volumes |
| `GET` | `/api/volumes/:id` | Volume metadata |
| `DELETE` | `/api/volumes/:id` | Delete a volume |
| `POST` | `/api/upload` | multipart `files[]` + optional `title` |
| `POST` | `/api/upload/zip` | multipart `archive` (`.zip`/`.cbz`) |
| `POST` | `/api/volumes/:id/ocr` | Start OCR (background job) |
| `POST` | `/api/volumes/:id/mokuro` | multipart `mokuro` — attach OCR data |
| `GET` | `/api/ocr/status` | OCR job status |
| `GET` | `/v/:id/pages/:file` | Serve a page image |
| `GET` | `/v/:id/mokuro` | Fetch the attached OCR JSON |
| `GET` | `/addon/*` | The Firefox add-on |

## Layout on disk

```
data/_volumes/<id>/
  volume.json      metadata: title, page list, attached OCR
  pages/001.jpg    pages, in reading order
```

## Running it

```bash
npm install
node server/index.js        # http://0.0.0.0:8790
```

It is also installed as a launch agent (`com.bing.mangacab`) so it starts at
login and is reachable over Tailscale:

```bash
./start.sh
```

## Tests

```bash
./test/run-all.sh
```

14 suites:

| Suite | Covers |
|---|---|
| `firefox add-on` | Runs the real add-on script against the app and drives it with real pointer events |
| `text zones` | Every text block has a zone; tapping reveals it on white; one at a time |
| `ui revamp` | Shelf ↔ reader navigation, back button, the three OCR modes, the `MANGA_CAB` API |
| `cache policy` | The app shell is never stale; the add-on is downloadable |
| `transcript button` | The transcript button on 4 phone viewports |
| `ocr transcript` | One OCR section per line, all characters rendered |
| `overlay lines` | Each section at its detected position (0px offset) |
| `real webtoon text` | 256/256 characters on the real Chinese webtoon, 0 clipped |
| `text scale` | Overlay text matches the artwork's lettering size |
| `text selection` | Tap-to-select a character, visible highlight, scrolling still works |
| `encoding` | Mangled multipart filenames are repaired |
| `ui` | Upload, render, scroll, responsive |
| `ocr pipeline` | The real mokuro run, end to end |
| `mokuro ocr integration` | Attaches a real `.mokuro`, checks the overlay geometry |
| `tailscale` | The whole thing over real Tailscale HTTPS under `/manga` |

## Mounting under a path prefix

The app resolves every URL against a prefix, so it works unchanged at
`/manga/` or at the root. Set it up with:

```bash
tailscale serve --bg --set-path /manga http://127.0.0.1:8790
```

## Feeding it from Komikku

Komikku stores downloads as:

```
/storage/emulated/0/Komikku/downloads/<Source>/<Manga>/<Chapter>/001.jpg
```

`~/mokuro/scripts/pull_komikku.py` pulls those off the phone over ADB and
lays them out for mokuro.
