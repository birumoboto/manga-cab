# MANGA.CAB

A browser reader for Chinese manga with selectable text.

Upload a folder, a `.zip` or a `.cbz`; the reader shows it as a
continuous vertical webtoon, runs OCR on the pages locally with
[mokuro](https://github.com/kha-white/mokuro), and draws the recognised
text back over the artwork so you can select, copy, translate, or look
it up. A ready-made Firefox add-on reads a speech bubble out loud the
moment you tap it.

**Everything runs on your own machine.** No cloud OCR, no API key, no
account. The OCR model never sees your images.

## Quick start

```bash
git clone <this-repo> manga-reader
cd manga-reader

# The OCR engine — a separate checkout with its own Python venv.
git clone https://github.com/birumoboto/mokuro-zh.git ~/mokuro
cd ~/mokuro
python3 -m venv .venv
.venv/bin/pip install -e .

cd ~/manga-reader
npm install
node server/index.js
```

Then open <http://127.0.0.1:8790>.

The reader looks for mokuro at `~/mokuro` by default. Override it with
environment variables:

```bash
MOKURO_DIR=/path/to/mokuro node server/index.js
```

### Put it on the tailnet

```bash
tailscale serve --bg --set-path /manga http://127.0.0.1:8790
```

Tailnet-only. Check your own hostname with:

```bash
tailscale status --json | python3 -c "import sys,json; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))"
```

### Run it at login (macOS)

`start.sh` is the launcher. To have it start automatically, copy the
launch-agent template, replace `__REPO__` with this checkout's absolute
path, and load it:

```bash
sed "s|__REPO__|$PWD|" com.bing.mangacab.plist.tmpl > ~/Library/LaunchAgents/com.bing.mangacab.plist
launchctl load ~/Library/LaunchAgents/com.bing.mangacab.plist
```

## The two screens

**SHELF** (the main menu) — your uploaded volumes as a list, plus the
dropzone for adding more. The app opens here.

**READER** — the webtoon itself, with a permanent **← SHELF** button in
the header. One tap gets you back to the menu, always. The phone's back
gesture works too.

## OCR display modes

| mode | what it does |
|---|---|
| **OFF** | no text layer |
| **TAP** | tap a character to highlight it; the page still scrolls normally |
| **READ** | the text is drawn over the artwork so you can select and copy it |

TAP mode hit-tests the characters itself, so the overlay never
intercepts your scroll.

## Text zones

Tap a speech bubble's zone and it is revealed on white with dark text —
readable even over dense artwork. Only one zone is revealed at a time,
and tapping outside collapses it.

## Typography

The overlay text is fitted to the artwork's **actual lettering**, not to
the box mokuro detected.

mokuro's `font_size` is the *quad's* size, not the glyph's — the quad
also contains the speech bubble's edges, so using it makes the text
about 40% too big. The size therefore comes from measuring the ink
inside the quad (`public/ink.js`).

The measurement is polarity-agnostic: it compares each row against its
own median, so it works on a white speech bubble on a black page and on
black text on white.

The font's own metrics (advance, ink height, ink width, side bearings)
are **measured by rasterising it**, not hardcoded, so a font
substitution cannot throw the calibration off.

Each line is then sized so its ink matches the artwork's glyph height,
condensed along its own axis so its advance matches the artwork's, and
positioned by its ink origin so the characters sit on the lettering
rather than beside it. The characters are never allowed to flex-shrink:
that squashes the glyph ink inside each character and makes the letters
overlap.

## OCR engines

The OCR sheet has a language picker and an engine picker.

| engine | speed | vertical Chinese | horizontal Chinese |
|---|---|---|---|
| **CnOCR** | fast | 5/7 exact on known columns | 98.5% |
| **PP-OCRv5** | slower | 7/7 exact on known columns | 99.1% |

PP-OCRv5 needs one change in mokuro to work: a vertical column has to
be presented with the characters **side by side**, not stacked down the
strip. mokuro stacks them, because that is how manga-ocr was trained. So
a recognizer declares which form it wants:

```python
class PaddleRecognizer:
    vertical_orientation = "sideways"   # manga-ocr and cnocr use "stacked"
```

On real artwork the two engines disagree, and on artwork-heavy pages
PP-OCRv5's high confidence can be confidently wrong — so CnOCR is the
default. See the README for the full comparison.

### The cache is per engine

mokuro caches each page's OCR under `_ocr/<name>/`. Without a per-engine
directory, switching the recognizer replays the previous engine's text —
the run appears to succeed and quietly produces the wrong text.

## The Firefox add-on

`addon/` holds a manifest and a content script. Every character is a
real DOM element, so an add-on can find and read it. See the README for
the `MANGA_CAB` API it uses.

## Tests

```bash
./test/run-all.sh
```

17 suites, all green. They drive the real app in headless Chrome and
compare the rendered overlay against the artwork's pixels — not just the
DOM.

| Suite | Covers |
|---|---|
| `typography` | Every line matches the artwork's lettering; no overlap; no bleed; vertical text; click-off clears the highlight |
| `ink match` | The overlay's glyphs are the artwork's size and sit on the artwork's lettering |
| `text zones` | Every text block has a zone; tapping reveals it on white; one at a time |
| `firefox add-on` | Runs the real add-on script against the app and drives it with real pointer events |
| `ui revamp` | Shelf ↔ reader navigation, back button, the three OCR modes, the `MANGA_CAB` API |
| `cache policy` | The app shell is never stale; the add-on is downloadable |
| `transcript button` | The transcript panel on four device sizes |
| `ocr transcript` | One section per line, grouped by page |
| `overlay lines` | One OCR section per detected line |
| `real webtoon text` | No sentence is truncated |
| `text scale` | The overlay matches the artwork's size |
| `text selection` | Tap-to-highlight, and the visible selection |
| `encoding` | Multipart filenames with non-ASCII characters |
| `ui` | The whole UI in headless Chrome |
| `ocr pipeline` | A real upload through a real mokuro run |
| `mokuro ocr integration` | mokuro's own output contract |
| `tailscale` | The site over real HTTPS through the tailnet |

### Looking at the result

```bash
node scripts/zoom-lines.js <volume-id>     # magnified crops of every OCR line
python3 scripts/make_zoom_panels.py shots/zoom shots
python3 scripts/analyze_panels.py shots/panels
```

`zoom-lines.js` captures the real rendered pixels for every line —
the artwork alone, the overlay alone, and the artwork with the overlay
on top — so the typography can be judged by eye as well as by number.

## Licence

GPL-3.0, matching mokuro.
