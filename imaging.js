// Canvas port of the Python pipeline: cut out, trim, square on white,
// levels (Cmd+L) and saturation (Cmd+U).

export const CARD_SIZE = 1400;
export const MARGIN = 0.06;

export function defaultEdit() {
  return { crop: null, black: 0, white: 255, gamma: 1.0, saturation: 1.0 };
}

function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Crop to the garment's own bounds, using alpha. */
export function trimToAlpha(canvas, alphaThreshold = 8) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return canvas; // fully transparent — nothing to trim

  const out = canvasOf(maxX - minX + 1, maxY - minY + 1);
  out.getContext("2d").drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Fit onto a white square with one even margin — this is what makes the grid read as a catalog. */
export function squareOnWhite(source, size = CARD_SIZE, margin = MARGIN) {
  const out = canvasOf(size, size);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);

  const inner = size * (1 - 2 * margin);
  const scale = Math.min(inner / source.width, inner / source.height);
  const w = source.width * scale;
  const h = source.height * scale;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, (size - w) / 2, (size - h) / 2, w, h);
  return out;
}

export function applyCrop(canvas, crop) {
  if (!crop) return canvas;
  const { width: w, height: h } = canvas;
  const x0 = Math.max(0, Math.min(w - 1, Math.round(crop.x0 * w)));
  const y0 = Math.max(0, Math.min(h - 1, Math.round(crop.y0 * h)));
  const x1 = Math.max(1, Math.min(w, Math.round(crop.x1 * w)));
  const y1 = Math.max(1, Math.min(h, Math.round(crop.y1 * h)));
  if (x1 <= x0 || y1 <= y0) return canvas;

  const out = canvasOf(x1 - x0, y1 - y0);
  out.getContext("2d").drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Levels + saturation in one pass. Alpha is left untouched. */
export function applyToneAndColor(canvas, { black = 0, white = 255, gamma = 1, saturation = 1 }) {
  const b = Math.max(0, Math.min(254, black));
  const wp = Math.max(b + 1, Math.min(255, white));
  const g = Math.max(0.1, Math.min(4, gamma));
  const sat = Math.max(0, Math.min(2, saturation));

  const lut = new Uint8ClampedArray(256);
  const span = wp - b;
  for (let i = 0; i < 256; i++) {
    let v = (i - b) / span;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    lut[i] = Math.round(Math.pow(v, 1 / g) * 255);
  }

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;

  const neutral = Math.abs(sat - 1) < 0.001;
  for (let i = 0; i < d.length; i += 4) {
    let r = lut[d[i]], gg = lut[d[i + 1]], bb = lut[d[i + 2]];
    if (!neutral) {
      // luma-preserving saturation, same idea as PIL's Color enhance
      const l = 0.299 * r + 0.587 * gg + 0.114 * bb;
      r = l + (r - l) * sat;
      gg = l + (gg - l) * sat;
      bb = l + (bb - l) * sat;
    }
    d[i] = r; d[i + 1] = gg; d[i + 2] = bb;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function cloneCanvas(canvas) {
  const out = canvasOf(canvas.width, canvas.height);
  out.getContext("2d").drawImage(canvas, 0, 0);
  return out;
}

export function rotate90(canvas) {
  const out = canvasOf(canvas.height, canvas.width);
  const ctx = out.getContext("2d");
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

/** Full render: crop -> tone/colour -> square on white. */
export function renderCard(originalCanvas, edit, size = CARD_SIZE) {
  let c = applyCrop(cloneCanvas(originalCanvas), edit.crop);
  c = applyToneAndColor(c, edit);
  return squareOnWhite(c, size);
}

export function canvasToBlob(canvas, type = "image/jpeg", quality = 0.88) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function blobToCanvas(blob) {
  const bitmap = await createImageBitmap(blob);
  const c = canvasOf(bitmap.width, bitmap.height);
  c.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  return c;
}

/** Downscale a huge phone photo before the model sees it — keeps memory sane. */
export async function fileToCanvas(file, maxSide = 2000) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const c = canvasOf(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  c.getContext("2d").drawImage(bitmap, 0, 0, c.width, c.height);
  bitmap.close();
  return c;
}
