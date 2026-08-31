# wardrobe

Digitize a wardrobe: drop in photos, get a clean catalog of cutout cards you can filter and export.

Everything runs in the browser. The background removal model is downloaded once and executed on
your own device — no server, no account, no upload. Your items are stored in this browser only.

## Using it

1. Add photos — hanging, flat, or against a plain wall all work.
2. Each item gets its background removed and is placed on a white square.
3. Tap a card to zoom, crop, rotate, adjust levels and saturation, or download it.
4. Sort into top / bottom / full / outerwear / shoes and filter the grid.

**Photograph against a plain light wall.** The background matters more than the model does — a dark
garment on a dark background is the one case that comes out badly.

## What is where

| file | what it does |
|---|---|
| `index.html` | markup |
| `style.css` | styling, including phone layout and touch behaviour |
| `app.js` | UI: grid, categories, filters, the editor |
| `bg.js` | background removal (Transformers.js + RMBG-1.4, WebGPU with a WASM fallback) |
| `imaging.js` | crop, levels, saturation, trimming, square-on-white |
| `store.js` | IndexedDB persistence |

No build step. It is plain ES modules — any static host will serve it.

## Running locally

```bash
python3 -m http.server 5051
```

Then open `http://localhost:5051`. Opening `index.html` as a file will not work, because ES modules
need a real origin.

## Notes and limits

- **The model downloads once** — 84 MB on a machine with a GPU, 42 MB on a phone —
  then the browser caches it.
- **Two builds of the same model.** With a GPU it runs fp16 weights on the graphics
  card, about 5 seconds a garment. Without one it runs quantized weights on the CPU:
  slower, but it fits in the memory a phone browser allows before killing the tab.
- **Data is per-browser.** The catalog does not sync between a phone and a laptop; each keeps its own.
  Clearing site data clears the catalog.
- **HEIC**: iPhones convert to JPEG when you pick a photo, so this works on a phone. Desktop browsers
  generally cannot decode a `.heic` file dragged in directly — convert it first.
- The cards are 1400×1400 JPEG on white, which is what marketplace listings want.

## Sibling project

There is a local Python version in `../cutout/` that uses BiRefNet — a heavier, more accurate model
that is too large to ship to a browser. Use that one when edge quality matters most.
