# MANGA.CAB

A webtoon reader for the browser. Upload a folder of JPGs (or a `.zip`/`.cbz`)
and read it as a continuous vertical strip — the way webtoons are actually
meant to be read.

Optionally attach a [mokuro](https://github.com/kha-white/mokuro) `.mokuro`
file to make the pages' text **selectable**, so you can copy, translate, or
look up dialogue.

## Live

```
https://bings-macbook-pro-2.tailb92b8e.ts.net/manga/
```

Tailnet-only (Tailscale Serve). Your phone needs to be on the same tailnet.

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
- **OCR text layer** — attach a `.mokuro` file and toggle selectable text
  over the artwork (press `O` or use the top-bar button).
- **Mobile-first** — safe-area insets, ≥32px tap targets, no horizontal
  overflow down to 375px wide.
- **Keyboard** — `←`/`→` page, `Home`/`End` jump, `O` toggles OCR, `Esc`
  closes the library.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/volumes` | List uploaded volumes |
| `GET` | `/api/volumes/:id` | Volume metadata |
| `DELETE` | `/api/volumes/:id` | Delete a volume |
| `POST` | `/api/upload` | multipart `files[]` + optional `title` |
| `POST` | `/api/upload/zip` | multipart `archive` (`.zip`/`.cbz`) |
| `POST` | `/api/volumes/:id/mokuro` | multipart `mokuro` — attach OCR data |
| `GET` | `/v/:id/pages/:file` | Serve a page image |
| `GET` | `/v/:id/mokuro` | Fetch the attached OCR JSON |

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

- `test/ui.verify.js` — headless Chrome: upload, render, scroll, OCR layer,
  responsive checks
- `test/mokuro.verify.js` — attaches a real `.mokuro` and verifies the
  overlay geometry and selectable text
- `test/tailscale.verify.js` — the whole thing over real Tailscale HTTPS
  under the `/manga` path prefix

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
