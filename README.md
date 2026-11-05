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
- tapping outside collapses it and clears the character highlight

## OCR engines

The OCR sheet has a language picker and an engine picker.

| engine | speed | vertical Chinese | horizontal Chinese |
|---|---|---|---|
| **CnOCR** | fast | drops characters from a column | 98.5% |
| **PP-OCRv5** | slower | reads columns exactly | 99.1% |

Measured on vertical columns with known text
(`mokuro/tests/compare_vertical_recognizers.py`):

```
cnocr    columns read exactly 5/7   character accuracy 93.3%
paddle   columns read exactly 7/7   character accuracy 100.0%
```

PP-OCRv5 needed one change to work, and it is in mokuro: a vertical
column has to be presented with the characters **side by side**, not
stacked down the strip. mokuro stacks them, because that is how
manga-ocr was trained. So a recogniser now declares which form it
wants:

```python
class PaddleRecognizer:
    vertical_orientation = "sideways"   # manga-ocr and cnocr use "stacked"
```

The orientation A/B, on columns with known text
(`mokuro/tests/paddle_orientation_fix.py`):

```
cnocr    stacked   5/7 exact,  93.3% characters
         sideways  0/7 exact,   6.7% characters
ppocr    stacked   0/7 exact,  13.3% characters
         sideways  7/7 exact, 100.0% characters
```

On the real webtoon both engines return the same 25 blocks, because
CnOCR was already correct there — its three "vertical" blocks are
single large title-logo glyphs (福 / 茶 / 露), not columns.

## Typography

The overlay text is fitted to the artwork's **actual lettering**, not to
the box mokuro detected.

mokuro's `font_size` is the *quad's* size, not the glyph's — the quad
also contains the speech bubble's edges and the page around the
lettering, so using it makes the text about 40% too big. So the size
comes from measuring the ink inside the quad (`public/ink.js`).

The measurement is polarity-agnostic: it compares each row against its
own median, so it works on a white speech bubble on a black page and on
black text on white. Guessing the polarity from the histogram does not
work — the crop's modal brightness is usually the page, not the bubble.

The font's own metrics (advance, ink height, ink width, side bearings)
are **measured by rasterising it**, not hardcoded, so a font
substitution cannot throw the calibration off.

Each line is then:

- sized so its ink matches the artwork's glyph height
- condensed along its own axis so its advance matches the artwork's
- positioned by its ink origin, so the characters sit on the lettering
  rather than beside it
- **never allowed to flex-shrink** — that squashes the glyph ink inside
  each character and makes the letters overlap

Verified against the real Chinese webtoon (`预告_91dbdb`, 31 lines):

```
overlay/artwork size ratio — median 1.000, mean 0.993
position error — median |dx| 7.0px, |dy| 5.7px
no characters overlap — 0 lines with overlaps
```

### White panel

The white panel is painted on the **line**, not the block: a block can
hold several lines with different quads, and the panel has to hug the
text. Its vertical padding clears the em box, so the characters never
poke out of the bottom.

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
- **Two OCR engines** — pick CnOCR (fast) or PP-OCRv5 (accurate, and the
  one that reads vertical columns properly). See below.
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
| `typography` | Every line matches the artwork's lettering; no overlap; no bleed; vertical text; click-off clears the highlight |
| `ink match` | The overlay's glyphs are the artwork's size and sit on the artwork's lettering |
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
