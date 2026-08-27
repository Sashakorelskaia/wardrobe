import { allItems, putItem, getItem, deleteItem, newId } from "./store.js";
import { init as initModel, removeBackground, backendName } from "./bg.js";
import {
  defaultEdit,
  fileToCanvas,
  trimToAlpha,
  renderCard,
  rotate90,
  applyToneAndColor,
  cloneCanvas,
  canvasToBlob,
  blobToCanvas,
} from "./imaging.js";

const CATS = [
  { key: "top", label: "top" },
  { key: "bottom", label: "btm" },
  { key: "full", label: "full" },
  { key: "outerwear", label: "outr" },
  { key: "shoes", label: "shoe" },
];

let items = [];
let activeFilter = "all";
const cardUrls = new Map(); // id -> object URL, so we can revoke on replace

const $ = (id) => document.getElementById(id);
const grid = $("grid");
const filtersEl = $("filters");
const countEl = $("count");
const dropzone = $("dropzone");
const dropzoneSub = $("dropzoneSub");
const fileInput = $("fileInput");
const progressEl = $("progress");
const progressLabel = $("progressLabel");
const progressFill = $("progressFill");
const emptyState = $("emptyState");
const exampleEl = $("example");
const exampleGrid = $("exampleGrid");

// The example is never stored. It is shown on an empty catalogue and dropped
// from memory the moment a real garment exists, so there is nothing to clean up.
let exampleLoaded = false;
let exampleDismissed = false;

async function showExample() {
  if (exampleLoaded || exampleDismissed) return;
  exampleLoaded = true;
  try {
    const res = await fetch("demo.json");
    if (!res.ok) return;
    const payload = await res.json();
    exampleGrid.innerHTML = "";
    for (const rec of payload.items) {
      const blob = await dataUrlToBlob(rec.original);
      const canvas = await blobToCanvas(blob);
      const edit = { ...defaultEdit(), ...(rec.edit || {}) };
      const card = await canvasToBlob(renderCard(canvas, edit), "image/jpeg", 0.85);
      exampleGrid.appendChild(
        renderCard_({ id: rec.id, category: rec.category, card, edit }, { readOnly: true })
      );
    }
    if (!items.length && !exampleDismissed) exampleEl.hidden = false;
  } catch (err) {
    console.error("example failed to load", err);
  }
}

$("hideExample").onclick = () => {
  exampleDismissed = true;
  exampleEl.hidden = true;
  exampleGrid.innerHTML = "";
};

// ---- rendering ----

function cardUrl(item) {
  const existing = cardUrls.get(item.id);
  if (existing) URL.revokeObjectURL(existing);
  const url = URL.createObjectURL(item.card);
  cardUrls.set(item.id, url);
  return url;
}

function render() {
  countEl.textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;

  const visible = items.filter((it) => {
    if (activeFilter === "all") return true;
    if (activeFilter === "unsorted") return !it.category;
    return it.category === activeFilter;
  });

  grid.innerHTML = "";
  for (const item of visible) grid.appendChild(renderCard_(item));

  const empty = items.length === 0;
  emptyState.hidden = !empty;
  if (empty) {
    showExample();
  } else if (!exampleEl.hidden) {
    exampleEl.hidden = true;
    exampleGrid.innerHTML = "";
  }
}

function renderCard_(item, { readOnly = false } = {}) {
  const card = document.createElement("div");
  card.className = "card" + (item.category ? "" : " unsorted");

  const img = document.createElement("img");
  img.className = "card-image";
  img.src = cardUrl(item);
  img.alt = "";
  if (!readOnly) img.onclick = () => openLightbox(item.id);
  card.appendChild(img);

  if (!readOnly) {
    const del = document.createElement("button");
    del.className = "card-delete";
    del.textContent = "×";
    del.title = "delete";
    del.setAttribute("aria-label", "delete");
    del.onclick = (e) => {
      e.stopPropagation();
      askDelete(item.id);
    };
    card.appendChild(del);
  }

  const cats = document.createElement("div");
  cats.className = "card-cats";
  for (const c of CATS) {
    const btn = document.createElement("button");
    btn.className = "card-cat" + (item.category === c.key ? " selected" : "");
    btn.textContent = c.label;
    if (!readOnly) {
      btn.onclick = () => setCategory(item.id, item.category === c.key ? null : c.key);
    } else {
      btn.disabled = true;
    }
    cats.appendChild(btn);
  }
  card.appendChild(cats);
  return card;
}

async function setCategory(id, category) {
  const item = items.find((it) => it.id === id);
  if (!item) return;
  item.category = category;
  await putItem(item);
  render();
}

// ---- confirm dialog ----

let confirmResolve = null;
function confirmDialog(text) {
  $("confirmText").textContent = text;
  $("confirmOverlay").hidden = false;
  return new Promise((resolve) => (confirmResolve = resolve));
}
function closeConfirm(answer) {
  $("confirmOverlay").hidden = true;
  if (confirmResolve) confirmResolve(answer);
  confirmResolve = null;
}
$("confirmCancel").onclick = () => closeConfirm(false);
$("confirmOk").onclick = () => closeConfirm(true);

async function askDelete(id) {
  if (!(await confirmDialog("delete this item?"))) return;
  await deleteItem(id);
  const url = cardUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    cardUrls.delete(id);
  }
  items = items.filter((it) => it.id !== id);
  render();
}

// ---- adding photos ----

async function ensureModel() {
  let announced = false;
  await initModel((p) => {
    if (p.status === "progress" && p.file?.endsWith(".onnx")) {
      const pct = Math.round(p.progress || 0);
      progressLabel.textContent = `first run — loading the model, ${pct}%`;
      progressFill.style.width = `${pct}%`;
      announced = true;
    } else if (!announced) {
      progressLabel.textContent = "first run — loading the model…";
    }
  });
}

async function addFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;

  progressEl.hidden = false;
  progressFill.style.width = "0%";
  progressLabel.textContent = "preparing…";

  try {
    await ensureModel();
  } catch (err) {
    progressLabel.textContent = "could not load the model — check the connection and reload";
    console.error(err);
    return;
  }

  for (let i = 0; i < files.length; i++) {
    progressLabel.textContent = `processing ${i + 1} / ${files.length} — ${files[i].name}`;
    progressFill.style.width = `${Math.round((i / files.length) * 100)}%`;
    try {
      const photo = await fileToCanvas(files[i]);
      const cut = await removeBackground(photo);
      const original = trimToAlpha(cut);
      const edit = defaultEdit();
      const card = renderCard(original, edit);

      const item = {
        id: newId(),
        category: null,
        edit,
        original: await canvasToBlob(original, "image/png"),
        card: await canvasToBlob(card, "image/jpeg", 0.88),
      };
      await putItem(item);
      items.push(item);
      render();
    } catch (err) {
      console.error("failed on", files[i].name, err);
    }
    progressFill.style.width = `${Math.round(((i + 1) / files.length) * 100)}%`;
  }

  progressLabel.textContent = `done — ${files.length} processed`;
  setTimeout(() => {
    progressEl.hidden = true;
    progressFill.style.width = "0%";
  }, 2000);
}

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  addFiles(e.target.files);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
  })
);
dropzone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

filtersEl.addEventListener("click", (e) => {
  if (!e.target.classList.contains("filter")) return;
  activeFilter = e.target.dataset.filter;
  [...filtersEl.children].forEach((b) => b.classList.toggle("active", b === e.target));
  render();
});

// ---- backup: export / import ----
// The catalog lives only in this browser, so a file you can carry matters.

async function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

$("exportBtn").onclick = async () => {
  if (!items.length) return;
  progressEl.hidden = false;
  progressLabel.textContent = "packing a backup…";
  progressFill.style.width = "0%";

  const payload = { version: 1, items: [] };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    payload.items.push({
      id: it.id,
      category: it.category,
      edit: it.edit,
      original: await blobToDataUrl(it.original),
    });
    progressFill.style.width = `${Math.round(((i + 1) / items.length) * 100)}%`;
  }

  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "wardrobe-export.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  progressLabel.textContent = `saved — ${items.length} items`;
  setTimeout(() => {
    progressEl.hidden = true;
    progressFill.style.width = "0%";
  }, 2000);
};

$("importBtn").onclick = () => $("importInput").click();

$("importInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  progressEl.hidden = false;
  progressLabel.textContent = "reading the file…";
  progressFill.style.width = "0%";

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    progressLabel.textContent = "that file is not a wardrobe backup";
    return;
  }
  if (!Array.isArray(payload.items)) {
    progressLabel.textContent = "that file is not a wardrobe backup";
    return;
  }

  const existing = new Set(items.map((it) => it.id));
  let added = 0;

  for (let i = 0; i < payload.items.length; i++) {
    const rec = payload.items[i];
    progressLabel.textContent = `importing ${i + 1} / ${payload.items.length}`;
    progressFill.style.width = `${Math.round((i / payload.items.length) * 100)}%`;
    try {
      const original = await dataUrlToBlob(rec.original);
      const canvas = await blobToCanvas(original);
      const edit = { ...defaultEdit(), ...(rec.edit || {}) };
      const item = {
        id: existing.has(rec.id) ? newId() : rec.id,
        category: rec.category ?? null,
        edit,
        original,
        card: await canvasToBlob(renderCard(canvas, edit), "image/jpeg", 0.88),
      };
      await putItem(item);
      items.push(item);
      added++;
      render();
    } catch (err) {
      console.error("import failed for", rec.id, err);
    }
  }

  progressFill.style.width = "100%";
  progressLabel.textContent = `imported — ${added} items`;
  setTimeout(() => {
    progressEl.hidden = true;
    progressFill.style.width = "0%";
  }, 2500);
});

// ---- lightbox: rotate, crop, levels, saturation ----

const lightbox = $("lightbox");
const lightboxImg = $("lightboxImg");
const lightboxStage = $("lightboxStage");
const cropBox = $("cropBox");
const masks = {
  top: $("maskTop"),
  bottom: $("maskBottom"),
  left: $("maskLeft"),
  right: $("maskRight"),
};
const sliders = { black: $("sBlack"), white: $("sWhite"), gamma: $("sGamma"), sat: $("sSat") };
const readouts = { black: $("vBlack"), white: $("vWhite"), gamma: $("vGamma"), sat: $("vSat") };

let currentId = null;
let currentOriginal = null; // canvas
let cropNorm = null;
let dragMode = null;
let dragStart = null;
let resizeAnchor = null;
let moveStart = null;
let cropAtMoveStart = null;
let previewUrl = null;

function editValues() {
  return {
    black: Number(sliders.black.value),
    white: Number(sliders.white.value),
    gamma: Number(sliders.gamma.value) / 100,
    saturation: Number(sliders.sat.value) / 100,
  };
}

function updateReadouts() {
  readouts.black.textContent = sliders.black.value;
  readouts.white.textContent = sliders.white.value;
  readouts.gamma.textContent = (Number(sliders.gamma.value) / 100).toFixed(2);
  readouts.sat.textContent = (Number(sliders.sat.value) / 100).toFixed(2);
}

function setSliders(edit) {
  sliders.black.value = edit.black;
  sliders.white.value = edit.white;
  sliders.gamma.value = Math.round(edit.gamma * 100);
  sliders.sat.value = Math.round(edit.saturation * 100);
  updateReadouts();
}

async function openLightbox(id) {
  const item = items.find((it) => it.id === id);
  if (!item) return;
  currentId = id;
  currentOriginal = await blobToCanvas(item.original);
  cropNorm = item.edit?.crop || null;
  setSliders(item.edit || defaultEdit());
  lightbox.hidden = false;
  await refreshPreview();
  drawCrop();
}

function closeLightbox() {
  lightbox.hidden = true;
  currentId = null;
  currentOriginal = null;
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
}

/** Live preview shows the whole frame with tone applied; the crop box is drawn over it. */
async function refreshPreview() {
  if (!currentOriginal) return;
  const c = applyToneAndColor(cloneCanvas(currentOriginal), editValues());
  const flat = document.createElement("canvas");
  flat.width = c.width;
  flat.height = c.height;
  const fx = flat.getContext("2d");
  fx.fillStyle = "#ffffff";
  fx.fillRect(0, 0, flat.width, flat.height);
  fx.drawImage(c, 0, 0);

  const blob = await canvasToBlob(flat, "image/jpeg", 0.85);
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  await new Promise((res) => {
    lightboxImg.onload = res;
    lightboxImg.src = previewUrl;
  });
  drawCrop();
}

let previewTimer = null;
Object.values(sliders).forEach((s) =>
  s.addEventListener("input", () => {
    updateReadouts();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 120);
  })
);

$("lightboxClose").onclick = closeLightbox;
$("lightboxCancel").onclick = closeLightbox;
$("clearCrop").onclick = () => {
  cropNorm = null;
  drawCrop();
};
$("lightboxReset").onclick = async () => {
  cropNorm = null;
  setSliders(defaultEdit());
  await refreshPreview();
};

$("rotateRight").onclick = async () => {
  if (!currentOriginal) return;
  currentOriginal = rotate90(currentOriginal);
  cropNorm = null; // crop was in the old orientation
  const item = items.find((it) => it.id === currentId);
  item.original = await canvasToBlob(currentOriginal, "image/png");
  item.edit = { ...editValues(), crop: null };
  item.card = await canvasToBlob(renderCard(currentOriginal, item.edit), "image/jpeg", 0.88);
  await putItem(item);
  await refreshPreview();
  render();
};

$("downloadBtn").onclick = async () => {
  const item = items.find((it) => it.id === currentId);
  if (!item) return;
  const url = URL.createObjectURL(item.card);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${item.category || "item"}-${item.id}.jpg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

$("lightboxSave").onclick = async () => {
  const item = items.find((it) => it.id === currentId);
  if (!item) return;
  item.edit = { ...editValues(), crop: cropNorm };
  item.card = await canvasToBlob(renderCard(currentOriginal, item.edit), "image/jpeg", 0.88);
  await putItem(item);
  closeLightbox();
  render();
};

// ---- crop interaction (square only) ----

function imgRect() {
  return lightboxImg.getBoundingClientRect();
}

function pointToNorm(clientX, clientY) {
  const r = imgRect();
  return {
    x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
  };
}

/**
 * Grow a square from a fixed anchor, clamped so it never leaves the photo.
 * Coordinates are normalised 0–1, but the square must be square in *pixels* —
 * so the side is measured in pixels and converted back per axis.
 */
function squareBox(anchor, point) {
  const r = imgRect();
  const W = r.width || 1;
  const H = r.height || 1;

  const dxPx = (point.x - anchor.x) * W;
  const dyPx = (point.y - anchor.y) * H;
  const sx = dxPx >= 0 ? 1 : -1;
  const sy = dyPx >= 0 ? 1 : -1;

  const availX = (sx > 0 ? 1 - anchor.x : anchor.x) * W;
  const availY = (sy > 0 ? 1 - anchor.y : anchor.y) * H;
  const sidePx = Math.min(Math.max(Math.abs(dxPx), Math.abs(dyPx)), availX, availY);

  const cx = anchor.x + (sx * sidePx) / W;
  const cy = anchor.y + (sy * sidePx) / H;
  return {
    x0: Math.min(anchor.x, cx),
    y0: Math.min(anchor.y, cy),
    x1: Math.max(anchor.x, cx),
    y1: Math.max(anchor.y, cy),
  };
}

function drawCrop() {
  const r = imgRect();
  if (!r.width || !cropNorm) {
    cropBox.hidden = true;
    Object.values(masks).forEach((m) => {
      m.style.width = "0px";
      m.style.height = "0px";
    });
    return;
  }
  const stageR = lightboxStage.getBoundingClientRect();
  const offX = r.left - stageR.left;
  const offY = r.top - stageR.top;
  const left = cropNorm.x0 * r.width;
  const top = cropNorm.y0 * r.height;
  const w = (cropNorm.x1 - cropNorm.x0) * r.width;
  const h = (cropNorm.y1 - cropNorm.y0) * r.height;

  cropBox.hidden = false;
  Object.assign(cropBox.style, {
    left: `${offX + left}px`,
    top: `${offY + top}px`,
    width: `${w}px`,
    height: `${h}px`,
  });

  Object.assign(masks.top.style, {
    left: `${offX}px`, top: `${offY}px`, width: `${r.width}px`, height: `${top}px`,
  });
  Object.assign(masks.bottom.style, {
    left: `${offX}px`, top: `${offY + top + h}px`, width: `${r.width}px`,
    height: `${r.height - top - h}px`,
  });
  Object.assign(masks.left.style, {
    left: `${offX}px`, top: `${offY + top}px`, width: `${left}px`, height: `${h}px`,
  });
  Object.assign(masks.right.style, {
    left: `${offX + left + w}px`, top: `${offY + top}px`,
    width: `${r.width - left - w}px`, height: `${h}px`,
  });
}

function insideCrop(n) {
  return cropNorm && n.x >= cropNorm.x0 && n.x <= cropNorm.x1 && n.y >= cropNorm.y0 && n.y <= cropNorm.y1;
}

const OPPOSITE = {
  nw: (c) => ({ x: c.x1, y: c.y1 }),
  ne: (c) => ({ x: c.x0, y: c.y1 }),
  sw: (c) => ({ x: c.x1, y: c.y0 }),
  se: (c) => ({ x: c.x0, y: c.y0 }),
};

cropBox.querySelectorAll(".crop-handle").forEach((handle) =>
  handle.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    dragMode = "resize";
    resizeAnchor = OPPOSITE[handle.dataset.corner](cropNorm);
    lightboxStage.setPointerCapture(e.pointerId);
  })
);

lightboxStage.addEventListener("pointerdown", (e) => {
  const n = pointToNorm(e.clientX, e.clientY);
  if (insideCrop(n)) {
    dragMode = "move";
    moveStart = n;
    cropAtMoveStart = { ...cropNorm };
  } else {
    dragMode = "draw";
    dragStart = n;
    cropNorm = squareBox(n, n);
  }
  lightboxStage.setPointerCapture(e.pointerId);
});

lightboxStage.addEventListener("pointermove", (e) => {
  if (!dragMode) return;
  const n = pointToNorm(e.clientX, e.clientY);
  if (dragMode === "draw") cropNorm = squareBox(dragStart, n);
  else if (dragMode === "resize") cropNorm = squareBox(resizeAnchor, n);
  else {
    const sideX = cropAtMoveStart.x1 - cropAtMoveStart.x0;
    const sideY = cropAtMoveStart.y1 - cropAtMoveStart.y0;
    const x0 = Math.min(1 - sideX, Math.max(0, cropAtMoveStart.x0 + n.x - moveStart.x));
    const y0 = Math.min(1 - sideY, Math.max(0, cropAtMoveStart.y0 + n.y - moveStart.y));
    cropNorm = { x0, y0, x1: x0 + sideX, y1: y0 + sideY };
  }
  drawCrop();
});

lightboxStage.addEventListener("pointerup", () => {
  if (dragMode === "draw" && cropNorm && cropNorm.x1 - cropNorm.x0 < 0.02) cropNorm = null;
  dragMode = null;
  drawCrop();
});

window.addEventListener("resize", () => {
  if (!lightbox.hidden) drawCrop();
});

// ---- start ----

(async () => {
  items = await allItems();
  render();
  if (!(navigator.gpu)) {
    dropzoneSub.textContent =
      "background is removed on your device — nothing is uploaded (slower without WebGPU)";
  }
})();
